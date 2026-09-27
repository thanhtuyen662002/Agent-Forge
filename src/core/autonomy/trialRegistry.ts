import crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  canonicalizeTrialEvidenceManifest,
  computeTrialEvidenceManifestSha256,
  PRODUCTION_TRIAL_PHASES,
  type ProductionTrialEvidenceManifest,
  type ProductionTrialOutcome,
  type ProductionTrialPhase,
} from './trialEvidence';

/**
 * Durable local identity and lifecycle for one operator-run trial.
 *
 * The registry deliberately lives in the autonomy extension schema rather than
 * the product migration ledger.  It binds a run to the canonical manifest
 * digest and only permits monotonic, fail-closed transitions.  It does not
 * authorize providers, approvals, or production execution.
 */
export type TrialRunState = 'REGISTERED' | 'RUNNING' | ProductionTrialOutcome;

export interface TrialRunRecord {
  trialId: string;
  runId: string;
  phase: ProductionTrialPhase;
  state: TrialRunState;
  manifestSha256: string;
  sourceCommitSha: string;
  sourceTreeSha: string;
  databaseProjectionSha256: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface TrialRunEvent {
  id: string;
  trialId: string;
  runId: string;
  sequence: number;
  eventType: 'TRIAL_RUN_REGISTERED' | 'TRIAL_RUN_STARTED' | 'TRIAL_RUN_COMPLETED';
  state: TrialRunState;
  payloadJson: string;
  createdAt: string;
}

export interface TrialRunHold {
  status: 'HOLD';
  reason: 'TRIAL_RUN_NOT_FOUND';
  trialId: string;
  runId: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail('TRIAL_RUN_INVALID_ID', `${field} must be a bounded safe identifier`);
  }
  return value;
}

function requireSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('TRIAL_RUN_INVALID_HASH', `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function rowToRecord(row: Record<string, unknown>): TrialRunRecord {
  return {
    trialId: String(row.trial_id),
    runId: String(row.run_id),
    phase: String(row.phase) as ProductionTrialPhase,
    state: String(row.state) as TrialRunState,
    manifestSha256: String(row.manifest_sha256),
    sourceCommitSha: String(row.source_commit_sha),
    sourceTreeSha: String(row.source_tree_sha),
    databaseProjectionSha256: row.database_projection_sha256 === null || row.database_projection_sha256 === undefined
      ? null
      : String(row.database_projection_sha256),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    updatedAt: String(row.updated_at),
  };
}

function eventRowToRecord(row: Record<string, unknown>): TrialRunEvent {
  return {
    id: String(row.id),
    trialId: String(row.trial_id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    eventType: String(row.event_type) as TrialRunEvent['eventType'],
    state: String(row.state) as TrialRunState,
    payloadJson: String(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export class TrialRunRegistry {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Registers one immutable `(trialId, runId)` identity. Repeating the exact
   * registration is idempotent; rebinding it to any other manifest fails.
   */
  register(
    manifest: ProductionTrialEvidenceManifest,
    manifestSha256?: string,
    runId?: string,
  ): TrialRunRecord {
    // Re-read the canonicalized value after validation so direct callers
    // cannot persist an uppercase or otherwise non-normalized field from a
    // structurally typed but untrusted object.
    const canonicalJson = canonicalizeTrialEvidenceManifest(manifest);
    const normalizedManifest = JSON.parse(canonicalJson) as ProductionTrialEvidenceManifest;
    const canonicalSha = computeTrialEvidenceManifestSha256(canonicalJson);
    if (manifestSha256 !== undefined && manifestSha256 !== canonicalSha) {
      fail('TRIAL_RUN_MANIFEST_HASH_MISMATCH', 'supplied digest does not match the canonical manifest');
    }
    const digest = requireSha(manifestSha256 ?? canonicalSha, 'manifestSha256');
    const trialId = requireId(normalizedManifest.trialId, 'trialId');
    const normalizedRunId = requireId(runId ?? crypto.randomUUID(), 'runId');
    if (!PRODUCTION_TRIAL_PHASES.includes(normalizedManifest.phase)) {
      fail('TRIAL_RUN_INVALID_PHASE', `unsupported phase ${String(normalizedManifest.phase)}`);
    }

    const now = this.clock();
    return this.db.transaction(() => {
      const existing = this.get(trialId, normalizedRunId);
      if (existing) {
        if (
          existing.phase !== normalizedManifest.phase
          || existing.manifestSha256 !== digest
          || existing.sourceCommitSha !== normalizedManifest.source.commitSha
          || existing.sourceTreeSha !== normalizedManifest.source.treeSha
          || existing.databaseProjectionSha256 !== normalizedManifest.artifacts.databaseProjectionSha256
        ) {
          fail('TRIAL_RUN_IDENTITY_CONFLICT', 'existing run is bound to a different manifest identity');
        }
        return existing;
      }

      this.db.prepare(`
        INSERT INTO autonomy_trial_runs (
          trial_id, run_id, phase, state, manifest_sha256, source_commit_sha,
          source_tree_sha, database_projection_sha256, created_at, started_at,
          finished_at, updated_at
        ) VALUES (?, ?, ?, 'REGISTERED', ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        trialId,
        normalizedRunId,
        normalizedManifest.phase,
        digest,
        normalizedManifest.source.commitSha,
        normalizedManifest.source.treeSha,
        normalizedManifest.artifacts.databaseProjectionSha256,
        now,
        now,
      );
      this.appendEvent(trialId, normalizedRunId, 'TRIAL_RUN_REGISTERED', 'REGISTERED', {
        phase: normalizedManifest.phase,
        manifestSha256: digest,
        sourceCommitSha: normalizedManifest.source.commitSha,
        sourceTreeSha: normalizedManifest.source.treeSha,
        databaseProjectionSha256: normalizedManifest.artifacts.databaseProjectionSha256,
      }, now);
      return this.get(trialId, normalizedRunId)!;
    })();
  }

  get(trialId: string, runId: string): TrialRunRecord | null {
    const normalizedTrialId = requireId(trialId, 'trialId');
    const normalizedRunId = requireId(runId, 'runId');
    const row = this.db.prepare('SELECT * FROM autonomy_trial_runs WHERE trial_id = ? AND run_id = ?')
      .get(normalizedTrialId, normalizedRunId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(trialId?: string): TrialRunRecord[] {
    const rows = trialId === undefined
      ? this.db.prepare('SELECT * FROM autonomy_trial_runs ORDER BY trial_id, created_at, run_id').all()
      : this.db.prepare('SELECT * FROM autonomy_trial_runs WHERE trial_id = ? ORDER BY created_at, run_id').all(requireId(trialId, 'trialId'));
    return (rows as Record<string, unknown>[]).map(rowToRecord);
  }

  start(trialId: string, runId: string): TrialRunRecord {
    return this.transition(trialId, runId, 'RUNNING');
  }

  complete(trialId: string, runId: string, outcome: ProductionTrialOutcome): TrialRunRecord {
    if (!['PASS', 'HOLD', 'FAIL'].includes(outcome)) {
      fail('TRIAL_RUN_INVALID_OUTCOME', `unsupported outcome ${String(outcome)}`);
    }
    return this.transition(trialId, runId, outcome);
  }

  require(trialId: string, runId: string): TrialRunRecord | TrialRunHold {
    const normalizedTrialId = requireId(trialId, 'trialId');
    const normalizedRunId = requireId(runId, 'runId');
    const record = this.get(normalizedTrialId, normalizedRunId);
    return record ?? { status: 'HOLD', reason: 'TRIAL_RUN_NOT_FOUND', trialId: normalizedTrialId, runId: normalizedRunId };
  }

  listEvents(trialId: string, runId: string): TrialRunEvent[] {
    const normalizedTrialId = requireId(trialId, 'trialId');
    const normalizedRunId = requireId(runId, 'runId');
    const rows = this.db.prepare(`
      SELECT * FROM autonomy_trial_run_events
      WHERE trial_id = ? AND run_id = ? ORDER BY sequence ASC
    `).all(normalizedTrialId, normalizedRunId);
    return (rows as Record<string, unknown>[]).map(eventRowToRecord);
  }

  private transition(trialId: string, runId: string, target: TrialRunState): TrialRunRecord {
    const normalizedTrialId = requireId(trialId, 'trialId');
    const normalizedRunId = requireId(runId, 'runId');
    const now = this.clock();
    return this.db.transaction(() => {
      const current = this.get(normalizedTrialId, normalizedRunId);
      if (!current) fail('TRIAL_RUN_NOT_FOUND', `${normalizedTrialId}/${normalizedRunId} is not registered`);
      if (current.state === target) return current;

      const allowed = target === 'RUNNING'
        ? current.state === 'REGISTERED'
        : (target === 'HOLD' && (current.state === 'REGISTERED' || current.state === 'RUNNING'))
          || ((target === 'PASS' || target === 'FAIL') && current.state === 'RUNNING');
      if (!allowed) {
        fail('TRIAL_RUN_STATE_CONFLICT', `cannot transition ${current.state} to ${target}`);
      }

      const startedAt = target === 'RUNNING' ? now : current.startedAt;
      const finishedAt = target === 'PASS' || target === 'HOLD' || target === 'FAIL' ? now : current.finishedAt;
      this.db.prepare(`
        UPDATE autonomy_trial_runs
        SET state = ?, started_at = ?, finished_at = ?, updated_at = ?
        WHERE trial_id = ? AND run_id = ? AND state = ?
      `).run(target, startedAt, finishedAt, now, normalizedTrialId, normalizedRunId, current.state);
      const changed = this.get(normalizedTrialId, normalizedRunId);
      if (!changed || changed.state !== target) {
        fail('TRIAL_RUN_STATE_CONFLICT', 'run changed concurrently; retry after re-reading durable state');
      }
      this.appendEvent(
        normalizedTrialId,
        normalizedRunId,
        target === 'RUNNING' ? 'TRIAL_RUN_STARTED' : 'TRIAL_RUN_COMPLETED',
        target,
        { previousState: current.state, state: target },
        now,
      );
      return changed;
    })();
  }

  private appendEvent(
    trialId: string,
    runId: string,
    eventType: TrialRunEvent['eventType'],
    state: TrialRunState,
    payload: Record<string, unknown>,
    createdAt: string,
  ): void {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS max_sequence
      FROM autonomy_trial_run_events WHERE trial_id = ? AND run_id = ?
    `).get(trialId, runId) as { max_sequence: number };
    const sequence = Number(row.max_sequence) + 1;
    this.db.prepare(`
      INSERT INTO autonomy_trial_run_events
        (id, trial_id, run_id, sequence, event_type, state, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      trialId,
      runId,
      sequence,
      eventType,
      state,
      stableJson(payload),
      createdAt,
    );
  }
}
