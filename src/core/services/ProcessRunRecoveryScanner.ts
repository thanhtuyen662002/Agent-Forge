import crypto from 'crypto';
import Database from 'better-sqlite3';
import { ProcessRunner, ProcessLivenessObservation } from './ProcessRunner';

/**
 * A process row left in RUNNING state after a supervisor restart is not a
 * terminal result.  In particular, a missing direct PID does not prove that
 * a process tree (or a detached descendant) has exited.  Recovery therefore
 * records an observation and keeps the row fenced until an owner can provide
 * positive termination evidence.
 */
export type ProcessRunRecoveryClassification =
  | 'LIVE_PID_UNRESOLVED'
  | 'MISSING_PID_UNRESOLVED'
  | 'DEAD_PID_UNRESOLVED'
  | 'PID_STATE_UNKNOWN_UNRESOLVED';

export type ProcessRunRecoveryDisposition = 'UNRESOLVED_FENCED';

export interface ProcessRunRecoveryItem {
  executionId: string;
  pid: number | null;
  command: string;
  workingDirectory: string;
  startTime: string;
  /** Stable identity for this persisted process record, independent of scan time. */
  identityHash: string;
  pidObservation: ProcessLivenessObservation | 'MISSING';
  classification: ProcessRunRecoveryClassification;
  disposition: ProcessRunRecoveryDisposition;
}

export interface ProcessRunRecoveryScanReport {
  scannedCount: number;
  unresolvedCount: number;
  livePidCount: number;
  missingPidCount: number;
  deadPidCount: number;
  unknownPidCount: number;
  items: ProcessRunRecoveryItem[];
  scannedAt: string;
}

export interface ProcessRunRecoveryScannerOptions {
  /** Injectable for deterministic recovery tests. Defaults to ProcessRunner's safe probe. */
  observeProcess?: (pid: number) => ProcessLivenessObservation;
  now?: () => string;
}

interface PersistedProcessRunRow {
  id: unknown;
  pid: unknown;
  command: unknown;
  working_directory: unknown;
  status: unknown;
  start_time: unknown;
}

function normalizePid(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * Computes the durable identity of a process row from fields already persisted
 * by ProcessRunner.  This deliberately excludes the scan timestamp, so a
 * repeated restart can correlate the same uncertain run without mutating it.
 */
export function computeProcessRunIdentityHash(input: {
  executionId: string;
  pid: number | null;
  command: string;
  workingDirectory: string;
  startTime: string;
}): string {
  const canonical = JSON.stringify([
    input.executionId,
    input.pid,
    input.command,
    input.workingDirectory,
    input.startTime,
  ]);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function classify(observation: ProcessLivenessObservation | 'MISSING'): ProcessRunRecoveryClassification {
  switch (observation) {
    case 'LIVE':
      return 'LIVE_PID_UNRESOLVED';
    case 'DEAD':
      return 'DEAD_PID_UNRESOLVED';
    case 'MISSING':
      return 'MISSING_PID_UNRESOLVED';
    case 'UNKNOWN':
    default:
      return 'PID_STATE_UNKNOWN_UNRESOLVED';
  }
}

/**
 * Reconciles only persisted RUNNING process rows.  It intentionally performs
 * no terminal status updates and no process termination: liveness of a direct
 * PID cannot prove that its complete process tree is gone after a restart.
 */
export class ProcessRunRecoveryScanner {
  private readonly observeProcess: (pid: number) => ProcessLivenessObservation;
  private readonly now: () => string;

  constructor(private readonly db: Database.Database, options: ProcessRunRecoveryScannerOptions = {}) {
    this.observeProcess = options.observeProcess ?? ProcessRunner.observeProcessLiveness;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public scanAndReconcile(): ProcessRunRecoveryScanReport {
    const rows = this.db
      .prepare(`
        SELECT id, pid, command, working_directory, status, start_time
        FROM process_runs
        WHERE status = 'RUNNING'
        ORDER BY start_time ASC, id ASC
      `)
      .all() as PersistedProcessRunRow[];

    let livePidCount = 0;
    let missingPidCount = 0;
    let deadPidCount = 0;
    let unknownPidCount = 0;
    const items = rows.map((row): ProcessRunRecoveryItem => {
      const executionId = normalizeText(row.id);
      const pid = normalizePid(row.pid);
      let pidObservation: ProcessLivenessObservation | 'MISSING' = 'MISSING';

      if (pid === null) {
        missingPidCount += 1;
      } else {
        try {
          pidObservation = this.observeProcess(pid);
        } catch {
          // A probe error is uncertainty, never proof of termination.
          pidObservation = 'UNKNOWN';
        }
        if (pidObservation === 'LIVE') livePidCount += 1;
        else if (pidObservation === 'DEAD') deadPidCount += 1;
        else unknownPidCount += 1;
      }

      // ProcessRunner persists scrubbed commands, but legacy rows may predate
      // that guarantee. Never echo a raw command into the recovery report or
      // startup audit payload.
      const command = ProcessRunner.scrubSecrets(normalizeText(row.command));
      const workingDirectory = normalizeText(row.working_directory);
      const startTime = normalizeText(row.start_time);
      return {
        executionId,
        pid,
        command,
        workingDirectory,
        startTime,
        identityHash: computeProcessRunIdentityHash({ executionId, pid, command, workingDirectory, startTime }),
        pidObservation,
        classification: classify(pidObservation),
        disposition: 'UNRESOLVED_FENCED',
      };
    });

    return {
      scannedCount: items.length,
      unresolvedCount: items.length,
      livePidCount,
      missingPidCount,
      deadPidCount,
      unknownPidCount,
      items,
      scannedAt: this.now(),
    };
  }
}

