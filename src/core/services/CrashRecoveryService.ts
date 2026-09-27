import Database from 'better-sqlite3';
import { MigrationRunner } from '../database/migrations';
import { EventService } from './EventService';
import { Repository } from '../database/repositories';
import { ExecutionRecoveryScanner } from './ExecutionRecoveryScanner';
import { ExecutionRecoveryScanReport } from '../types/domain';
import { CoderSubmissionAdjudicationRecoveryScanner } from './CoderSubmissionAdjudicationRecoveryScanner';
import { AdjudicationRecoveryScanReport } from '../types/adjudication';
import { ProviderHealthObservationReplayReport } from './AccountHealthService';
import { replayProviderHealthObservations } from './ProviderHealthApplication';
import { ProcessRunRecoveryScanner, ProcessRunRecoveryScanReport } from './ProcessRunRecoveryScanner';

export interface RecoveryReport {
  migrationsApplied: boolean;
  orphanedProcessesCleaned: number;
  staleLeasesCleared: number;
  /** Legacy expired leases retained because an associated process remains fenced. */
  staleLeasesDeferred: number;
  recoveredAt: string;
  processRecovery: ProcessRunRecoveryScanReport;
  executionRecovery?: ExecutionRecoveryScanReport;
  adjudicationRecovery?: AdjudicationRecoveryScanReport;
  providerHealthReplay?: ProviderHealthObservationReplayReport;
}

export class CrashRecoveryService {
  constructor(
    private db: Database.Database,
    private repo: Repository,
    private eventService: EventService
  ) {}

  public performStartupRecovery(): RecoveryReport {
    console.log('[CrashRecovery] Starting startup recovery check...');
    const now = new Date().toISOString();

    // 1. Verify and run migrations
    MigrationRunner.run(this.db);

    // 2. Reconcile persisted process rows before any dispatch-capable recovery.
    // A direct PID observation is not proof that its complete process tree has
    // exited, so this scanner is intentionally read-only and leaves RUNNING
    // rows fenced for explicit owner resolution.
    const processRecovery = new ProcessRunRecoveryScanner(this.db).scanAndReconcile();

    // 3. Focused R5I Execution Recovery Scanner (runs after migrations, before dispatch-capable services)
    const scanner = new ExecutionRecoveryScanner(this.db, this.repo, this.eventService);
    const executionRecoveryReport = scanner.scanAndReconcile();

    // 3b. Focused R5J5 Coder Submission Adjudication Recovery Scanner
    const adjudicationScanner = new CoderSubmissionAdjudicationRecoveryScanner(this.db, this.repo, this.eventService);
    const adjudicationRecoveryReport = adjudicationScanner.scanAndReconcile();

    // 2c. Replay durable provider-health observations after lifecycle scanners
    // have reconciled their execution graph. Observation ingestion and account
    // mutation are separate transactions, so this closes the crash window
    // without inventing health state for unordered or unknown-authority rows.
    const providerHealthReplay = replayProviderHealthObservations(this.repo);

    // 4. Do not terminalize unfinished process runs here. RUNNING rows are
    // durable recovery fences; marking them CANCELLED would claim a process
    // tree termination that startup cannot prove.
    const orphanedProcessesCleaned = 0;

    // 5. Clear expired legacy task leases only when no unresolved process for
    // the same task remains. This prevents recovery from releasing capacity
    // while a detached process tree may still own the task.
    const staleLeasesInfo = this.db
      .prepare(`
        UPDATE task_leases 
        SET released_at = ?
        WHERE released_at IS NULL
          AND expires_at < ?
          AND NOT EXISTS (
            SELECT 1
            FROM process_runs pr
            WHERE pr.task_id = task_leases.task_id
              AND pr.status = 'RUNNING'
          )
      `)
      .run(now, now);

    const deferredLeasesInfo = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM task_leases tl
        WHERE tl.released_at IS NULL
          AND tl.expires_at < ?
          AND EXISTS (
            SELECT 1
            FROM process_runs pr
            WHERE pr.task_id = tl.task_id
              AND pr.status = 'RUNNING'
          )
      `)
      .get(now) as { count: number };

    const report: RecoveryReport = {
      migrationsApplied: true,
      orphanedProcessesCleaned,
      staleLeasesCleared: staleLeasesInfo.changes,
      staleLeasesDeferred: Number(deferredLeasesInfo?.count ?? 0),
      recoveredAt: now,
      processRecovery,
      executionRecovery: executionRecoveryReport,
      adjudicationRecovery: adjudicationRecoveryReport,
      providerHealthReplay,
    };

    const allProjects = this.repo.getAllProjects();
    for (const proj of allProjects) {
      this.eventService.record(
        proj.id,
        'SYSTEM_STARTUP_RECOVERY',
        `Startup recovery complete. Kept ${report.processRecovery.unresolvedCount} process runs recovery-fenced, released ${report.staleLeasesCleared} stale leases (${report.staleLeasesDeferred} deferred), scanned ${executionRecoveryReport.scannedCount} execution authorizations (${executionRecoveryReport.reconciledCount} reconciled, ${executionRecoveryReport.unresolvedCount} unresolved, ${executionRecoveryReport.rejectedCount} rejected, ${executionRecoveryReport.noOpCount} no-op), and replayed ${providerHealthReplay.scannedCount} provider health observations (${providerHealthReplay.appliedCount} applied, ${providerHealthReplay.alreadyAppliedCount} already applied, ${providerHealthReplay.unresolvedCount} unresolved, ${providerHealthReplay.errorCount} errors).`,
        report as unknown as Record<string, unknown>
      );
    }

    console.log('[CrashRecovery] Startup recovery completed successfully.', report);
    return report;
  }
}
