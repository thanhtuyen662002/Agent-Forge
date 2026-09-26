import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DatabaseEngine } from '../database/db';
import { MigrationRunner } from '../database/migrations';
import { AutonomyState, ManagerReview, WorkOrder, SelfHostTask } from './contracts';

export interface AutonomyWorkOrderRow {
  id: string;
  task_id: string;
  attempt: number;
  lease_epoch: number;
  worker_id: string;
  state: AutonomyState;
  payload_json: string;
  base_sha: string;
  branch: string;
  worktree: string;
  created_at: string;
  updated_at: string;
}

export interface AutonomySlot {
  slotId: string;
  workerId: string;
  workOrderId: string;
  leaseEpoch: number;
}

export interface AutonomyCiWatch {
  id: string;
  task_id: string;
  work_order_id: string | null;
  repository: string;
  pr_number: number;
  branch: string;
  expected_head_sha: string;
  state: 'CI_WAIT' | 'CI_SUCCESS' | 'CI_FAILURE' | 'REPAIR_QUEUED' | 'BLOCKED';
  repair_task_id: string | null;
  poll_attempt: number;
  next_poll_at: string;
  last_observed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutonomyReviewCapacityWait {
  id: string;
  task_id: string;
  context_sha: string;
  expected_head_sha: string;
  state: 'WAITING' | 'PASS' | 'REPAIR' | 'BLOCKED';
  attempt_count: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  last_error: string | null;
  selected_resource: string | null;
  verdict: 'PASS' | 'REPAIR' | 'BLOCKED' | null;
  created_at: string;
  updated_at: string;
}

export type ManagerResourceState =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'CREDITS_EXHAUSTED'
  | 'CAPACITY_EXHAUSTED'
  | 'COOLDOWN'
  | 'TIMEOUT'
  | 'OFFLINE'
  | 'CONTRACT_INVALID';
export interface ManagerResourceHealth { resource_id: string; state: ManagerResourceState; cooldown_until: string | null; last_error: string | null; updated_at: string; }

export type CiIdentityType = 'PR_HEAD_CI' | 'MAIN_POST_MERGE_CI';

export type MergeIdentityType = 'SQUASH' | 'LINEAR_HISTORY' | 'NONE';

export type CiReconciliationClassification =
  | 'PR_HEAD_SUCCESS'
  | 'DIFFERENT_MERGE_SHA_PUSH_SUCCESS'
  | 'LINEAR_HISTORY_MERGE_PUSH_SUCCESS'
  | 'MISSING_POST_MERGE_CI'
  | 'STALE_PR_HEAD_CI'
  | 'SUPERSEDED_HEAD'
  | 'PR_HEAD_FAILURE'
  | 'POST_MERGE_PUSH_FAILURE'
  | 'POST_MERGE_PUSH_PENDING';

export interface AutonomyCiReconciliation {
  id: string;
  repository: string;
  pr_number: number;
  pr_head_sha: string;
  merged_main_sha: string | null;
  pr_head_ci_identity: string;
  pr_head_event: 'pull_request';
  pr_head_conclusion: string | null;
  main_post_merge_ci_identity: string | null;
  main_post_merge_event: 'push';
  main_post_merge_conclusion: string | null;
  reconciliation_classification: CiReconciliationClassification;
  merge_identity_type: MergeIdentityType;
  details_json: string;
  created_at: string;
  updated_at: string;
}

export interface RecordCiReconciliationInput {
  id?: string;
  repository: string;
  prNumber: number;
  prHeadSha: string;
  mergedMainSha?: string | null;
  prHeadCiIdentity?: string;
  prHeadEvent?: 'pull_request';
  prHeadConclusion?: string | null;
  mainPostMergeCiIdentity?: string | null;
  mainPostMergeEvent?: 'push';
  mainPostMergeConclusion?: string | null;
  reconciliationClassification: CiReconciliationClassification;
  mergeIdentityType?: MergeIdentityType;
  details?: Record<string, unknown> | string;
}

/**
 * Autonomy state is an extension owned by the supervisor. The product migration
 * ledger is intentionally immutable at v24; this initializer is idempotent and
 * runs in the same SQLite transaction boundary before any WorkOrder is accepted.
 */
export const AUTONOMY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS autonomy_work_orders (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    lease_epoch INTEGER NOT NULL, worker_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('READY','LEASED','IMPLEMENTING','LOCAL_VERIFY','MANAGER_REVIEW','REPAIR','PR_OPEN','CI_WAIT','MERGE_READY','MERGED','BLOCKED','FAILED')),
    payload_json TEXT NOT NULL, base_sha TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id, attempt)
  );
  CREATE INDEX IF NOT EXISTS idx_autonomy_work_orders_state ON autonomy_work_orders(state);
  CREATE INDEX IF NOT EXISTS idx_autonomy_work_orders_task ON autonomy_work_orders(task_id);
  CREATE TABLE IF NOT EXISTS autonomy_slots (
    slot_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, work_order_id TEXT REFERENCES autonomy_work_orders(id) ON DELETE SET NULL,
    lease_epoch INTEGER, leased_at TEXT, released_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_slots_active_worker ON autonomy_slots(worker_id) WHERE released_at IS NULL AND worker_id <> '';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_slots_active_order ON autonomy_slots(work_order_id) WHERE released_at IS NULL AND work_order_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS autonomy_runs (
    id TEXT PRIMARY KEY, work_order_id TEXT NOT NULL REFERENCES autonomy_work_orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_autonomy_runs_order ON autonomy_runs(work_order_id, started_at);
  CREATE TABLE IF NOT EXISTS autonomy_reviews (
    id TEXT PRIMARY KEY, work_order_id TEXT NOT NULL REFERENCES autonomy_work_orders(id) ON DELETE CASCADE,
    reviewed_head_sha TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('PASS','REPAIR','BLOCKED')),
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_autonomy_reviews_order ON autonomy_reviews(work_order_id, created_at);
  CREATE TABLE IF NOT EXISTS autonomy_claims (
    claim_key TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, work_order_id TEXT, head_sha TEXT, state TEXT NOT NULL, observed_at TEXT NOT NULL,
    UNIQUE(source, external_id)
  );
  CREATE TABLE IF NOT EXISTS autonomy_events (
    id TEXT PRIMARY KEY, work_order_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_autonomy_events_order ON autonomy_events(work_order_id, created_at);
  CREATE TABLE IF NOT EXISTS autonomy_ci_watches (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, work_order_id TEXT,
    repository TEXT NOT NULL, pr_number INTEGER NOT NULL, branch TEXT NOT NULL,
    expected_head_sha TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CI_WAIT','CI_SUCCESS','CI_FAILURE','REPAIR_QUEUED','BLOCKED')),
    repair_task_id TEXT, poll_attempt INTEGER NOT NULL DEFAULT 0,
    next_poll_at TEXT NOT NULL, last_observed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(repository, pr_number)
  );
  CREATE INDEX IF NOT EXISTS idx_autonomy_ci_watches_due ON autonomy_ci_watches(state, next_poll_at);
  CREATE TABLE IF NOT EXISTS autonomy_ci_reconciliations (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    pr_head_sha TEXT NOT NULL,
    merged_main_sha TEXT,
    pr_head_ci_identity TEXT NOT NULL,
    pr_head_event TEXT NOT NULL DEFAULT 'pull_request',
    pr_head_conclusion TEXT,
    main_post_merge_ci_identity TEXT,
    main_post_merge_event TEXT NOT NULL DEFAULT 'push',
    main_post_merge_conclusion TEXT,
    reconciliation_classification TEXT NOT NULL,
    merge_identity_type TEXT NOT NULL DEFAULT 'NONE',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repository, pr_number, pr_head_sha)
  );
  CREATE INDEX IF NOT EXISTS idx_autonomy_ci_recon_repo_pr ON autonomy_ci_reconciliations(repository, pr_number);
  CREATE INDEX IF NOT EXISTS idx_autonomy_ci_recon_pr_head ON autonomy_ci_reconciliations(pr_head_sha);
  CREATE INDEX IF NOT EXISTS idx_autonomy_ci_recon_main ON autonomy_ci_reconciliations(merged_main_sha);
  CREATE INDEX IF NOT EXISTS idx_autonomy_ci_recon_classification ON autonomy_ci_reconciliations(reconciliation_classification);
  CREATE TABLE IF NOT EXISTS autonomy_manager_resources (
    resource_id TEXT PRIMARY KEY, state TEXT NOT NULL, cooldown_until TEXT, last_error TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS autonomy_manager_attempts (
    id TEXT PRIMARY KEY, work_order_id TEXT, resource_id TEXT NOT NULL, context_sha TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS autonomy_manager_contexts (
    context_sha TEXT PRIMARY KEY, context_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS autonomy_review_capacity_waits (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    context_sha TEXT NOT NULL REFERENCES autonomy_manager_contexts(context_sha),
    expected_head_sha TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('WAITING','PASS','REPAIR','BLOCKED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_attempt_at TEXT,
    last_error TEXT,
    selected_resource TEXT,
    verdict TEXT CHECK(verdict IS NULL OR verdict IN ('PASS','REPAIR','BLOCKED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(context_sha, expected_head_sha)
  );
  CREATE INDEX IF NOT EXISTS idx_autonomy_review_capacity_due ON autonomy_review_capacity_waits(state, next_attempt_at);
  CREATE TABLE IF NOT EXISTS autonomy_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS autonomy_compatibility_inventory (
    table_name TEXT PRIMARY KEY,
    total_rows INTEGER NOT NULL,
    active_rows INTEGER NOT NULL,
    retained_status TEXT NOT NULL,
    is_lifecycle_authoritative INTEGER NOT NULL DEFAULT 0,
    inventoried_at TEXT NOT NULL,
    notes TEXT
  );
`;

export class AutonomyStore {
  constructor(private readonly db: Database.Database) { this.ensureSchema(); }

  static open(runtimeRoot: string): { store: AutonomyStore; engine: DatabaseEngine; dbPath: string } {
    const stateRoot = path.join(runtimeRoot, 'state');
    fs.mkdirSync(stateRoot, { recursive: true });
    const dbPath = path.join(stateRoot, 'agent-forge.sqlite');
    const engine = new DatabaseEngine(dbPath);
    const db = engine.init();
    MigrationRunner.run(db);
    const store = new AutonomyStore(db);
    store.ensureSchema();
    store.inventoryLegacyState();
    return { store, engine, dbPath };
  }

  getDatabase(): Database.Database { return this.db; }

  ensureSchema(): void {
    this.db.transaction(() => this.db.exec(AUTONOMY_SCHEMA_SQL))();
  }

  ensureSlots(maxWorkers: number): void {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32) throw new Error('MAX_AGY_WORKERS must be between 1 and 32');
    const insert = this.db.prepare('INSERT OR IGNORE INTO autonomy_slots (slot_id, worker_id) VALUES (?, ?)');
    for (let i = 1; i <= maxWorkers; i++) insert.run(`agy-${String(i).padStart(2, '0')}`, '');
  }

  createWorkOrder(order: WorkOrder): AutonomyWorkOrderRow {
    return this.db.transaction(() => this.insertWorkOrder(order))();
  }

  private insertWorkOrder(order: WorkOrder): AutonomyWorkOrderRow {
    if (this.isProductTask(order.task_id)) {
      throw new Error(`PRODUCT_TASK_CANNOT_USE_LEGACY_AUTONOMY_LIFECYCLE: task ${order.task_id} is a product task and must execute via ProductTaskAutonomyAdapter`);
    }
    const now = new Date().toISOString();
    const row: AutonomyWorkOrderRow = {
      id: crypto.randomUUID(), task_id: order.task_id, attempt: order.attempt, lease_epoch: order.lease_epoch,
      worker_id: order.worker_id, state: 'READY', payload_json: JSON.stringify(order), base_sha: order.base_sha,
      branch: order.branch, worktree: order.worktree, created_at: now, updated_at: now,
    };
    const active = this.db.prepare("SELECT id FROM autonomy_work_orders WHERE task_id = ? AND state NOT IN ('MERGED','BLOCKED','FAILED')").get(order.task_id);
    if (active) throw new Error(`DUPLICATE_DISPATCH: task ${order.task_id} already has an active WorkOrder`);
    const occupied = this.db.prepare("SELECT id FROM autonomy_work_orders WHERE lower(worktree) = lower(?) AND state NOT IN ('MERGED','BLOCKED','FAILED')").get(path.resolve(order.worktree));
    if (occupied) throw new Error('SHARED_WORKTREE_REJECTED');
    this.db.prepare(`INSERT INTO autonomy_work_orders (id,task_id,attempt,lease_epoch,worker_id,state,payload_json,base_sha,branch,worktree,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.task_id,row.attempt,row.lease_epoch,row.worker_id,row.state,row.payload_json,row.base_sha,row.branch,row.worktree,row.created_at,row.updated_at);
    this.event(row.id, 'WORKORDER_CREATED', order);
    return row;
  }

  getWorkOrder(id: string): AutonomyWorkOrderRow | null {
    return (this.db.prepare('SELECT * FROM autonomy_work_orders WHERE id = ?').get(id) as AutonomyWorkOrderRow | undefined) ?? null;
  }

  listAll(): AutonomyWorkOrderRow[] {
    return this.db.prepare('SELECT * FROM autonomy_work_orders ORDER BY created_at').all() as AutonomyWorkOrderRow[];
  }

  enqueue(task: SelfHostTask): void {
    this.db.transaction(() => {
      const exists = this.db.prepare('SELECT id FROM autonomy_events WHERE work_order_id=? AND event_type=?').get(task.task_id, 'TASK_QUEUED');
      if (exists) throw new Error('DUPLICATE_TASK_REQUEST');
      this.event(task.task_id, 'TASK_QUEUED', task);
    }).immediate();
  }

  claimNext(): SelfHostTask | null {
    return this.db.transaction(() => {
      const event = this.db.prepare("SELECT q.work_order_id,q.payload_json FROM autonomy_events q WHERE q.event_type='TASK_QUEUED' AND NOT EXISTS (SELECT 1 FROM autonomy_events c WHERE c.work_order_id=q.work_order_id AND c.event_type='TASK_CLAIMED') ORDER BY q.created_at LIMIT 1").get() as {work_order_id:string;payload_json:string}|undefined;
      if (!event) return null;
      this.event(event.work_order_id, 'TASK_CLAIMED', { pid: process.pid });
      return JSON.parse(event.payload_json) as SelfHostTask;
    }).immediate();
  }

  acquireOwner(): string {
    return this.db.transaction(() => {
      const owner = this.db.prepare('SELECT pid FROM autonomy_owner WHERE id=1').get() as { pid: number } | undefined;
      if (owner && AutonomyStore.isAlive(owner.pid)) throw new Error('SUPERVISOR_ALREADY_RUNNING');
      const token = crypto.randomUUID();
      this.db.prepare('INSERT OR REPLACE INTO autonomy_owner(id,pid,token,stop_requested) VALUES(1,?,?,0)').run(process.pid, token);
      return token;
    })();
  }

  releaseOwner(token: string): void { this.db.prepare('DELETE FROM autonomy_owner WHERE id=1 AND token=?').run(token); }
  requestStop(): void { this.db.prepare('UPDATE autonomy_owner SET stop_requested=1 WHERE id=1').run(); }
  shouldStop(): boolean { return !!(this.db.prepare('SELECT stop_requested FROM autonomy_owner WHERE id=1').get() as {stop_requested:number}|undefined)?.stop_requested; }
  static isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }

  listReady(): AutonomyWorkOrderRow[] {
    return this.db.prepare("SELECT * FROM autonomy_work_orders WHERE state IN ('READY','REPAIR') ORDER BY created_at ASC").all() as AutonomyWorkOrderRow[];
  }

  updateState(id: string, state: AutonomyState, expectedEpoch?: number): void {
    const now = new Date().toISOString();
    const result = expectedEpoch === undefined
      ? this.db.prepare('UPDATE autonomy_work_orders SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id)
      : this.db.prepare('UPDATE autonomy_work_orders SET state = ?, updated_at = ? WHERE id = ? AND lease_epoch = ?').run(state, now, id, expectedEpoch);
    if (result.changes !== 1) throw new Error(expectedEpoch === undefined ? `WORKORDER_NOT_FOUND: ${id}` : `LEASE_EPOCH_MISMATCH: ${id}`);
    this.event(id, 'STATE_CHANGED', { state, lease_epoch: expectedEpoch ?? null });
  }

  acquireSlot(workOrderId: string, workerId: string, leaseEpoch: number): AutonomySlot {
    return this.db.transaction(() => {
      const order = this.getWorkOrder(workOrderId);
      if (!order || order.lease_epoch !== leaseEpoch || order.worker_id !== workerId) throw new Error('LEASE_EPOCH_MISMATCH');
      if (!['READY', 'REPAIR'].includes(order.state)) throw new Error('DUPLICATE_DISPATCH: order is not executable');
      const shared = this.db.prepare('SELECT w.id FROM autonomy_slots s JOIN autonomy_work_orders w ON w.id=s.work_order_id WHERE s.released_at IS NULL AND lower(w.worktree)=lower(?)').get(order.worktree);
      if (shared) throw new Error('SHARED_WORKTREE_REJECTED');
      const row = this.db.prepare('SELECT * FROM autonomy_slots WHERE worker_id = ? AND released_at IS NULL').get(workerId) as Record<string, unknown> | undefined;
      if (row) throw new Error(`DUPLICATE_DISPATCH: worker ${workerId} already owns slot`);
      const slot = this.db.prepare('SELECT * FROM autonomy_slots WHERE released_at IS NOT NULL OR work_order_id IS NULL ORDER BY slot_id LIMIT 1').get() as Record<string, unknown> | undefined;
      if (!slot) throw new Error('NO_WORKER_CAPACITY: all Antigravity slots are leased');
      const now = new Date().toISOString();
      const result = this.db.prepare('UPDATE autonomy_slots SET worker_id = ?, work_order_id = ?, lease_epoch = ?, leased_at = ?, released_at = NULL WHERE slot_id = ? AND (released_at IS NOT NULL OR work_order_id IS NULL)')
        .run(workerId, workOrderId, leaseEpoch, now, String(slot.slot_id));
      if (result.changes !== 1) throw new Error('SLOT_FENCED: slot changed during acquisition');
      this.updateState(workOrderId, 'LEASED', leaseEpoch);
      return { slotId: String(slot.slot_id), workerId, workOrderId, leaseEpoch };
    })();
  }

  releaseSlot(slotId: string, workOrderId: string, leaseEpoch: number): void {
    const result = this.db.prepare("UPDATE autonomy_slots SET worker_id = '', work_order_id = NULL, lease_epoch = NULL, released_at = ? WHERE slot_id = ? AND work_order_id = ? AND lease_epoch = ? AND released_at IS NULL")
      .run(new Date().toISOString(), slotId, workOrderId, leaseEpoch);
    if (result.changes !== 1) throw new Error('LEASE_EPOCH_MISMATCH: slot release rejected');
  }

  recordRun(workOrderId: string, provider: string, run: { status: string; exitCode: number; stdout: string; stderr: string; durationMs: number }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO autonomy_runs (id,work_order_id,provider,status,exit_code,stdout,stderr,duration_ms,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, workOrderId, provider, run.status, run.exitCode, run.stdout, run.stderr, run.durationMs, now, now);
    return id;
  }

  recordReview(workOrderId: string, review: ManagerReview): void {
    this.db.prepare('INSERT INTO autonomy_reviews (id,work_order_id,reviewed_head_sha,verdict,payload_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), workOrderId, review.reviewed_head_sha, review.verdict, JSON.stringify(review), new Date().toISOString());
    this.event(workOrderId, 'MANAGER_REVIEWED', review);
  }

  claimExternal(source: string, externalId: string, workOrderId: string, headSha: string, state: string): boolean {
    try {
      this.db.prepare('INSERT INTO autonomy_claims (claim_key,source,external_id,work_order_id,head_sha,state,observed_at) VALUES (?,?,?,?,?,?,?)')
        .run(`${source}:${externalId}`, source, externalId, workOrderId, headSha, state, new Date().toISOString());
      return true;
    } catch (error) {
      if (String(error).includes('UNIQUE')) return false;
      throw error;
    }
  }

  reconcileExternalClaim(source: string, externalId: string, workOrderId: string, headSha: string, state: string): 'CREATED' | 'MATCHED' {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT work_order_id,head_sha FROM autonomy_claims WHERE source=? AND external_id=?').get(source, externalId) as { work_order_id: string; head_sha: string } | undefined;
      if (existing) {
        if (existing.work_order_id !== workOrderId) throw new Error('DUPLICATE_GITHUB_CLAIM');
        this.db.prepare('UPDATE autonomy_claims SET head_sha=?,state=?,observed_at=? WHERE source=? AND external_id=?').run(headSha, state, new Date().toISOString(), source, externalId);
        return 'MATCHED';
      }
      this.db.prepare('INSERT INTO autonomy_claims (claim_key,source,external_id,work_order_id,head_sha,state,observed_at) VALUES (?,?,?,?,?,?,?)')
        .run(`${source}:${externalId}`, source, externalId, workOrderId, headSha, state, new Date().toISOString());
      return 'CREATED';
    })();
  }

  registerCiWatch(input: { taskId: string; workOrderId?: string | null; repository: string; prNumber: number; branch: string; expectedHeadSha: string }): AutonomyCiWatch {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.db.prepare('SELECT * FROM autonomy_ci_watches WHERE repository=? AND pr_number=?').get(input.repository, input.prNumber) as AutonomyCiWatch | undefined;
      if (existing) {
        if (existing.task_id !== input.taskId || existing.branch !== input.branch) throw new Error('DUPLICATE_GITHUB_CLAIM');
        const now = new Date().toISOString();
        this.db.prepare("UPDATE autonomy_ci_watches SET expected_head_sha=?,state='CI_WAIT',repair_task_id=NULL,poll_attempt=0,next_poll_at=?,last_observed_at=NULL,updated_at=? WHERE id=?")
          .run(input.expectedHeadSha.toLowerCase(), now, now, existing.id);
        return this.db.prepare('SELECT * FROM autonomy_ci_watches WHERE id=?').get(existing.id) as AutonomyCiWatch;
      }
      const row: AutonomyCiWatch = {
        id: crypto.randomUUID(), task_id: input.taskId, work_order_id: input.workOrderId ?? null,
        repository: input.repository, pr_number: input.prNumber, branch: input.branch,
        expected_head_sha: input.expectedHeadSha.toLowerCase(), state: 'CI_WAIT', repair_task_id: null,
        poll_attempt: 0, next_poll_at: now, last_observed_at: null, created_at: now, updated_at: now,
      };
      this.db.prepare(`INSERT INTO autonomy_ci_watches (id,task_id,work_order_id,repository,pr_number,branch,expected_head_sha,state,repair_task_id,poll_attempt,next_poll_at,last_observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id,row.task_id,row.work_order_id,row.repository,row.pr_number,row.branch,row.expected_head_sha,row.state,row.repair_task_id,row.poll_attempt,row.next_poll_at,row.last_observed_at,row.created_at,row.updated_at);
      this.event(input.workOrderId ?? input.taskId, 'CI_WATCH_REGISTERED', row);
      return row;
    })();
  }

  listDueCiWatches(now = new Date().toISOString()): AutonomyCiWatch[] {
    return this.db.prepare("SELECT * FROM autonomy_ci_watches WHERE state IN ('CI_WAIT','CI_FAILURE') AND next_poll_at<=? ORDER BY next_poll_at").all(now) as AutonomyCiWatch[];
  }

  getCiWatchForRepairTask(taskId: string): AutonomyCiWatch | null {
    return (this.db.prepare('SELECT * FROM autonomy_ci_watches WHERE repair_task_id=?').get(taskId) as AutonomyCiWatch | undefined) ?? null;
  }

  updateCiWatch(id: string, changes: Partial<Pick<AutonomyCiWatch, 'work_order_id' | 'expected_head_sha' | 'state' | 'repair_task_id' | 'poll_attempt' | 'next_poll_at' | 'last_observed_at'>>): void {
    const entries = Object.entries(changes);
    if (!entries.length) return;
    const allowed = new Set(['work_order_id','expected_head_sha','state','repair_task_id','poll_attempt','next_poll_at','last_observed_at']);
    if (entries.some(([key]) => !allowed.has(key))) throw new Error('CI_WATCH_UPDATE_INVALID');
    const fields = entries.map(([key]) => `${key}=?`).join(',');
    const result = this.db.prepare(`UPDATE autonomy_ci_watches SET ${fields},updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error('CI_WATCH_NOT_FOUND');
  }

  recordCiReconciliation(input: RecordCiReconciliationInput): AutonomyCiReconciliation {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const prHeadSha = input.prHeadSha.toLowerCase();
    const mergedMainSha = input.mergedMainSha ? input.mergedMainSha.toLowerCase() : null;
    const prHeadEvent = input.prHeadEvent ?? 'pull_request';
    const mainPostMergeEvent = input.mainPostMergeEvent ?? 'push';
    const prHeadIdentity = input.prHeadCiIdentity ?? `PR_HEAD_CI:${input.repository}#${input.prNumber}@${prHeadSha}`;
    const mainPostMergeIdentity = input.mainPostMergeCiIdentity ?? (mergedMainSha ? `MAIN_POST_MERGE_CI:${input.repository}@${mergedMainSha}` : null);

    let mergeType: MergeIdentityType = input.mergeIdentityType ?? 'NONE';
    if (!input.mergeIdentityType && mergedMainSha) {
      mergeType = prHeadSha === mergedMainSha ? 'LINEAR_HISTORY' : 'SQUASH';
    }

    const detailsJson = typeof input.details === 'string'
      ? input.details
      : JSON.stringify(input.details ?? {});

    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO autonomy_ci_reconciliations (
          id, repository, pr_number, pr_head_sha, merged_main_sha,
          pr_head_ci_identity, pr_head_event, pr_head_conclusion,
          main_post_merge_ci_identity, main_post_merge_event, main_post_merge_conclusion,
          reconciliation_classification, merge_identity_type, details_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repository, pr_number, pr_head_sha) DO UPDATE SET
          merged_main_sha = excluded.merged_main_sha,
          pr_head_ci_identity = excluded.pr_head_ci_identity,
          pr_head_event = excluded.pr_head_event,
          pr_head_conclusion = excluded.pr_head_conclusion,
          main_post_merge_ci_identity = excluded.main_post_merge_ci_identity,
          main_post_merge_event = excluded.main_post_merge_event,
          main_post_merge_conclusion = excluded.main_post_merge_conclusion,
          reconciliation_classification = excluded.reconciliation_classification,
          merge_identity_type = excluded.merge_identity_type,
          details_json = excluded.details_json,
          updated_at = excluded.updated_at
      `).run(
        id, input.repository, input.prNumber, prHeadSha, mergedMainSha,
        prHeadIdentity, prHeadEvent, input.prHeadConclusion ?? null,
        mainPostMergeIdentity, mainPostMergeEvent, input.mainPostMergeConclusion ?? null,
        input.reconciliationClassification, mergeType, detailsJson, now, now
      );

      const row = this.db.prepare(
        'SELECT * FROM autonomy_ci_reconciliations WHERE repository = ? AND pr_number = ? AND pr_head_sha = ?'
      ).get(input.repository, input.prNumber, prHeadSha) as AutonomyCiReconciliation;

      this.event(`${input.repository}#${input.prNumber}`, 'CI_RECONCILIATION_RECORDED', row);
      return row;
    })();
  }

  getCiReconciliation(id: string): AutonomyCiReconciliation | null {
    return (this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE id = ?').get(id) as AutonomyCiReconciliation | undefined) ?? null;
  }

  getCiReconciliationByPr(repository: string, prNumber: number): AutonomyCiReconciliation | null {
    return (this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE repository = ? AND pr_number = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1').get(repository, prNumber) as AutonomyCiReconciliation | undefined) ?? null;
  }

  getCiReconciliationByPrAndHead(repository: string, prNumber: number, prHeadSha: string): AutonomyCiReconciliation | null {
    return (this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE repository = ? AND pr_number = ? AND lower(pr_head_sha) = lower(?)').get(repository, prNumber, prHeadSha) as AutonomyCiReconciliation | undefined) ?? null;
  }

  findCiReconciliationsByHeadSha(headSha: string): AutonomyCiReconciliation[] {
    return this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE lower(pr_head_sha) = lower(?) ORDER BY updated_at DESC, created_at DESC').all(headSha) as AutonomyCiReconciliation[];
  }

  findCiReconciliationsByMainSha(mainSha: string): AutonomyCiReconciliation[] {
    return this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE lower(merged_main_sha) = lower(?) ORDER BY updated_at DESC, created_at DESC').all(mainSha) as AutonomyCiReconciliation[];
  }

  listCiReconciliations(filter?: { repository?: string; classification?: CiReconciliationClassification }): AutonomyCiReconciliation[] {
    if (filter?.repository && filter?.classification) {
      return this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE repository = ? AND reconciliation_classification = ? ORDER BY updated_at DESC, created_at DESC').all(filter.repository, filter.classification) as AutonomyCiReconciliation[];
    }
    if (filter?.repository) {
      return this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE repository = ? ORDER BY updated_at DESC, created_at DESC').all(filter.repository) as AutonomyCiReconciliation[];
    }
    if (filter?.classification) {
      return this.db.prepare('SELECT * FROM autonomy_ci_reconciliations WHERE reconciliation_classification = ? ORDER BY updated_at DESC, created_at DESC').all(filter.classification) as AutonomyCiReconciliation[];
    }
    return this.db.prepare('SELECT * FROM autonomy_ci_reconciliations ORDER BY updated_at DESC, created_at DESC').all() as AutonomyCiReconciliation[];
  }

  findLatestWorkOrderByTask(taskId: string): AutonomyWorkOrderRow | null {
    return (this.db.prepare('SELECT * FROM autonomy_work_orders WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(taskId) as AutonomyWorkOrderRow | undefined) ?? null;
  }

  getManagerResourceHealth(resourceId: string): ManagerResourceHealth | null {
    return (this.db.prepare('SELECT * FROM autonomy_manager_resources WHERE resource_id=?').get(resourceId) as ManagerResourceHealth | undefined) ?? null;
  }

  listManagerResourceHealth(): ManagerResourceHealth[] { return this.db.prepare('SELECT * FROM autonomy_manager_resources ORDER BY resource_id').all() as ManagerResourceHealth[]; }

  recordManagerResource(resourceId: string, state: ManagerResourceState, error: string | null, cooldownUntil: string | null = null): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO autonomy_manager_resources(resource_id,state,cooldown_until,last_error,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET state=excluded.state,cooldown_until=excluded.cooldown_until,last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .run(resourceId, state, cooldownUntil, error, now);
  }

  recordManagerAttempt(workOrderId: string | null, resourceId: string, contextSha: string, state: string): void {
    this.db.prepare('INSERT INTO autonomy_manager_attempts(id,work_order_id,resource_id,context_sha,state,created_at) VALUES(?,?,?,?,?,?)')
      .run(crypto.randomUUID(), workOrderId, resourceId, contextSha, state, new Date().toISOString());
  }

  recordManagerContext(contextSha: string, contextJson: string): void {
    this.db.prepare('INSERT OR IGNORE INTO autonomy_manager_contexts(context_sha,context_json,created_at) VALUES(?,?,?)')
      .run(contextSha, contextJson, new Date().toISOString());
    const persisted = this.db.prepare('SELECT context_json FROM autonomy_manager_contexts WHERE context_sha=?').get(contextSha) as { context_json: string } | undefined;
    if (!persisted || persisted.context_json !== contextJson) throw new Error('MANAGER_CONTEXT_HASH_COLLISION');
  }

  getManagerContext(contextSha: string): string | null {
    const row = this.db.prepare('SELECT context_json FROM autonomy_manager_contexts WHERE context_sha=?').get(contextSha) as { context_json: string } | undefined;
    return row?.context_json ?? null;
  }

  registerReviewCapacityWait(input: {
    taskId: string;
    contextSha: string;
    expectedHeadSha: string;
    nextAttemptAt?: string;
  }): AutonomyReviewCapacityWait {
    if (!/^[0-9a-f]{64}$/i.test(input.contextSha)) throw new Error('REVIEW_WAIT_CONTEXT_SHA_INVALID');
    if (!/^[0-9a-f]{40}$/i.test(input.expectedHeadSha)) throw new Error('REVIEW_WAIT_HEAD_SHA_INVALID');
    if (!this.getManagerContext(input.contextSha)) throw new Error('MANAGER_CONTEXT_NOT_FOUND');
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const nextAttemptAt = input.nextAttemptAt ?? now;
      const existing = this.db.prepare(
        'SELECT * FROM autonomy_review_capacity_waits WHERE context_sha=? AND expected_head_sha=?'
      ).get(input.contextSha.toLowerCase(), input.expectedHeadSha.toLowerCase()) as AutonomyReviewCapacityWait | undefined;
      if (existing) {
        if (existing.task_id !== input.taskId) throw new Error('REVIEW_WAIT_TASK_MISMATCH');
        this.db.prepare(
          "UPDATE autonomy_review_capacity_waits SET state='WAITING',next_attempt_at=?,last_error=NULL,selected_resource=NULL,verdict=NULL,updated_at=? WHERE id=?"
        ).run(nextAttemptAt, now, existing.id);
        const row = this.db.prepare('SELECT * FROM autonomy_review_capacity_waits WHERE id=?').get(existing.id) as AutonomyReviewCapacityWait;
        this.event(input.taskId, 'WAITING_REVIEW_CAPACITY', row);
        return row;
      }
      const row: AutonomyReviewCapacityWait = {
        id: crypto.randomUUID(),
        task_id: input.taskId,
        context_sha: input.contextSha.toLowerCase(),
        expected_head_sha: input.expectedHeadSha.toLowerCase(),
        state: 'WAITING',
        attempt_count: 0,
        next_attempt_at: nextAttemptAt,
        last_attempt_at: null,
        last_error: null,
        selected_resource: null,
        verdict: null,
        created_at: now,
        updated_at: now,
      };
      this.db.prepare(
        `INSERT INTO autonomy_review_capacity_waits
        (id,task_id,context_sha,expected_head_sha,state,attempt_count,next_attempt_at,last_attempt_at,last_error,selected_resource,verdict,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        row.id,row.task_id,row.context_sha,row.expected_head_sha,row.state,row.attempt_count,row.next_attempt_at,
        row.last_attempt_at,row.last_error,row.selected_resource,row.verdict,row.created_at,row.updated_at
      );
      this.event(input.taskId, 'WAITING_REVIEW_CAPACITY', row);
      return row;
    })();
  }

  listReviewCapacityWaits(): AutonomyReviewCapacityWait[] {
    return this.db.prepare('SELECT * FROM autonomy_review_capacity_waits ORDER BY created_at').all() as AutonomyReviewCapacityWait[];
  }

  listDueReviewCapacityWaits(now = new Date().toISOString()): AutonomyReviewCapacityWait[] {
    return this.db.prepare(
      "SELECT * FROM autonomy_review_capacity_waits WHERE state='WAITING' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at"
    ).all(now) as AutonomyReviewCapacityWait[];
  }

  updateReviewCapacityWait(
    id: string,
    changes: Partial<Pick<AutonomyReviewCapacityWait,
      'state' | 'attempt_count' | 'next_attempt_at' | 'last_attempt_at' | 'last_error' | 'selected_resource' | 'verdict'
    >>,
  ): void {
    const entries = Object.entries(changes);
    if (!entries.length) return;
    const allowed = new Set(['state','attempt_count','next_attempt_at','last_attempt_at','last_error','selected_resource','verdict']);
    if (entries.some(([key]) => !allowed.has(key))) throw new Error('REVIEW_WAIT_UPDATE_INVALID');
    const fields = entries.map(([key]) => `${key}=?`).join(',');
    const result = this.db.prepare(
      `UPDATE autonomy_review_capacity_waits SET ${fields},updated_at=? WHERE id=?`
    ).run(...entries.map(([, value]) => value), new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error('REVIEW_WAIT_NOT_FOUND');
  }

  listActiveSlots(): AutonomySlot[] {
    return (this.db.prepare('SELECT slot_id,worker_id,work_order_id,lease_epoch FROM autonomy_slots WHERE released_at IS NULL AND work_order_id IS NOT NULL').all() as Array<Record<string, unknown>>)
      .map((row) => ({ slotId: String(row.slot_id), workerId: String(row.worker_id), workOrderId: String(row.work_order_id), leaseEpoch: Number(row.lease_epoch) }));
  }

  event(workOrderId: string, eventType: string, payload: unknown): void {
    this.db.prepare('INSERT INTO autonomy_events (id,work_order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), workOrderId, eventType, JSON.stringify(payload), new Date().toISOString());
  }

  isProductTask(taskId: string): boolean {
    try {
      const hasTasks = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
      if (!hasTasks) return false;
      const row = this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId);
      return !!row;
    } catch {
      return false;
    }
  }

  isLegacyTableAuthoritative(tableName: string): boolean {
    // Legacy autonomy lifecycle rows are explicitly non-authoritative for product tasks
    if (tableName === 'autonomy_work_orders') return false;
    return false;
  }

  inventoryLegacyState(): LegacyAutonomyInventoryReport {
    const db = this.db;
    const now = new Date().toISOString();

    const countTable = (name: string, where?: string): number => {
      try {
        const query = where ? `SELECT COUNT(*) as cnt FROM ${name} WHERE ${where}` : `SELECT COUNT(*) as cnt FROM ${name}`;
        const row = db.prepare(query).get() as { cnt: number } | undefined;
        return row?.cnt ?? 0;
      } catch {
        return 0;
      }
    };

    const tables: LegacyTableInventory[] = [
      {
        tableName: 'autonomy_work_orders',
        totalRows: countTable('autonomy_work_orders'),
        activeRows: countTable('autonomy_work_orders', "state NOT IN ('MERGED','BLOCKED','FAILED')"),
        retainedStatus: 'RETAINED_READ_ONLY_COMPATIBILITY',
        isAuthoritative: false,
        notes: 'Legacy autonomy lifecycle rows retained for audit/compatibility; non-authoritative for product tasks',
      },
      {
        tableName: 'autonomy_slots',
        totalRows: countTable('autonomy_slots'),
        activeRows: countTable('autonomy_slots', 'released_at IS NULL AND work_order_id IS NOT NULL'),
        retainedStatus: 'RETAINED_ACTIVE_LEASES',
        isAuthoritative: false,
        notes: 'Legacy worker slots retained; new product tasks use WorkerSlotLeaseService',
      },
      {
        tableName: 'autonomy_runs',
        totalRows: countTable('autonomy_runs'),
        activeRows: countTable('autonomy_runs'),
        retainedStatus: 'RETAINED_ACTIVE_EVIDENCE',
        isAuthoritative: false,
        notes: 'Execution run records retained as audit evidence',
      },
      {
        tableName: 'autonomy_reviews',
        totalRows: countTable('autonomy_reviews'),
        activeRows: countTable('autonomy_reviews'),
        retainedStatus: 'RETAINED_ACTIVE_REVIEWS',
        isAuthoritative: false,
        notes: 'Manager review history retained for audit',
      },
      {
        tableName: 'autonomy_ci_watches',
        totalRows: countTable('autonomy_ci_watches'),
        activeRows: countTable('autonomy_ci_watches', "state IN ('CI_WAIT','CI_FAILURE')"),
        retainedStatus: 'RETAINED_ACTIVE_WATCHES',
        isAuthoritative: false,
        notes: 'Active CI watches retained and continuously monitored',
      },
      {
        tableName: 'autonomy_ci_reconciliations',
        totalRows: countTable('autonomy_ci_reconciliations'),
        activeRows: countTable('autonomy_ci_reconciliations'),
        retainedStatus: 'RETAINED_ACTIVE_WATCHES',
        isAuthoritative: false,
        notes: 'Durable CI identity reconciliations relating PR head and post-merge main CI',
      },
      {
        tableName: 'autonomy_claims',
        totalRows: countTable('autonomy_claims'),
        activeRows: countTable('autonomy_claims'),
        retainedStatus: 'RETAINED_COMPATIBILITY_CLAIMS',
        isAuthoritative: false,
        notes: 'External GitHub/PR claims retained',
      },
      {
        tableName: 'autonomy_events',
        totalRows: countTable('autonomy_events'),
        activeRows: countTable('autonomy_events'),
        retainedStatus: 'RETAINED_AUDIT_LOGS',
        isAuthoritative: false,
        notes: 'Event stream retained for historical traceability',
      },
      {
        tableName: 'autonomy_manager_resources',
        totalRows: countTable('autonomy_manager_resources'),
        activeRows: countTable('autonomy_manager_resources'),
        retainedStatus: 'RETAINED_MANAGER_RESOURCES',
        isAuthoritative: false,
        notes: 'Manager resource health states retained',
      },
      {
        tableName: 'autonomy_manager_attempts',
        totalRows: countTable('autonomy_manager_attempts'),
        activeRows: countTable('autonomy_manager_attempts'),
        retainedStatus: 'RETAINED_MANAGER_ATTEMPTS',
        isAuthoritative: false,
        notes: 'Manager attempt history retained',
      },
      {
        tableName: 'autonomy_manager_contexts',
        totalRows: countTable('autonomy_manager_contexts'),
        activeRows: countTable('autonomy_manager_contexts'),
        retainedStatus: 'RETAINED_MANAGER_CONTEXTS',
        isAuthoritative: false,
        notes: 'Manager context snapshots retained',
      },
      {
        tableName: 'autonomy_review_capacity_waits',
        totalRows: countTable('autonomy_review_capacity_waits'),
        activeRows: countTable('autonomy_review_capacity_waits', "state='WAITING'"),
        retainedStatus: 'RETAINED_REVIEW_CAPACITY_WAITS',
        isAuthoritative: false,
        notes: 'Durable review-capacity waits retained across Supervisor restarts without consuming worker slots',
      },
    ];

    try {
      const insertOrReplace = db.prepare(`
        INSERT OR REPLACE INTO autonomy_compatibility_inventory
        (table_name, total_rows, active_rows, retained_status, is_lifecycle_authoritative, inventoried_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      db.transaction(() => {
        for (const t of tables) {
          insertOrReplace.run(
            t.tableName,
            t.totalRows,
            t.activeRows,
            t.retainedStatus,
            t.isAuthoritative ? 1 : 0,
            now,
            t.notes
          );
        }
      })();
    } catch {
      // Table may not exist yet or running in raw mode
    }

    return {
      inventoriedAt: now,
      tables,
      totalRetainedRows: tables.reduce((acc, t) => acc + t.totalRows, 0),
      activeRetainedCount: tables.reduce((acc, t) => acc + t.activeRows, 0),
    };
  }
}

export type LegacyRetainedStatus =
  | 'RETAINED_READ_ONLY_COMPATIBILITY'
  | 'RETAINED_ACTIVE_LEASES'
  | 'RETAINED_ACTIVE_EVIDENCE'
  | 'RETAINED_ACTIVE_REVIEWS'
  | 'RETAINED_ACTIVE_WATCHES'
  | 'RETAINED_COMPATIBILITY_CLAIMS'
  | 'RETAINED_AUDIT_LOGS'
  | 'RETAINED_MANAGER_RESOURCES'
  | 'RETAINED_MANAGER_ATTEMPTS'
  | 'RETAINED_MANAGER_CONTEXTS'
  | 'RETAINED_REVIEW_CAPACITY_WAITS';

export interface LegacyTableInventory {
  tableName: string;
  totalRows: number;
  activeRows: number;
  retainedStatus: LegacyRetainedStatus;
  isAuthoritative: boolean;
  notes: string;
}

export interface LegacyAutonomyInventoryReport {
  inventoriedAt: string;
  tables: LegacyTableInventory[];
  totalRetainedRows: number;
  activeRetainedCount: number;
}

export function migrateLegacyAutonomyCompatibility(db: Database.Database): LegacyAutonomyInventoryReport {
  const store = new AutonomyStore(db);
  return store.inventoryLegacyState();
}
