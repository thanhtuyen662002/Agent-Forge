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
  CREATE TABLE IF NOT EXISTS autonomy_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0);
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

  listActiveSlots(): AutonomySlot[] {
    return (this.db.prepare('SELECT slot_id,worker_id,work_order_id,lease_epoch FROM autonomy_slots WHERE released_at IS NULL AND work_order_id IS NOT NULL').all() as Array<Record<string, unknown>>)
      .map((row) => ({ slotId: String(row.slot_id), workerId: String(row.worker_id), workOrderId: String(row.work_order_id), leaseEpoch: Number(row.lease_epoch) }));
  }

  event(workOrderId: string, eventType: string, payload: unknown): void {
    this.db.prepare('INSERT INTO autonomy_events (id,work_order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), workOrderId, eventType, JSON.stringify(payload), new Date().toISOString());
  }
}
