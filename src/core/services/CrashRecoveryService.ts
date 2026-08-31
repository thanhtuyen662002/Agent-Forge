import Database from 'better-sqlite3';
import { MigrationRunner } from '../database/migrations';
import { EventService } from './EventService';
import { Repository } from '../database/repositories';
import { ExecutionRecoveryScanner } from './ExecutionRecoveryScanner';
import { ExecutionRecoveryScanReport } from '../types/domain';

export interface RecoveryReport {
  migrationsApplied: boolean;
  orphanedProcessesCleaned: number;
  staleLeasesCleared: number;
  recoveredAt: string;
  executionRecovery?: ExecutionRecoveryScanReport;
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

    // 2. Focused R5I Execution Recovery Scanner (runs after migrations, before dispatch-capable services)
    const scanner = new ExecutionRecoveryScanner(this.db, this.repo, this.eventService);
    const executionRecoveryReport = scanner.scanAndReconcile();

    // 3. Mark any unfinished legacy process runs from a prior crashed session as CANCELLED
    const orphanedProcInfo = this.db
      .prepare(`
        UPDATE process_runs 
        SET status = 'CANCELLED', end_time = ?
        WHERE status = 'RUNNING'
      `)
      .run(now);

    // 4. Clear expired legacy task leases
    const staleLeasesInfo = this.db
      .prepare(`
        UPDATE task_leases 
        SET released_at = ?
        WHERE released_at IS NULL AND expires_at < ?
      `)
      .run(now, now);

    const report: RecoveryReport = {
      migrationsApplied: true,
      orphanedProcessesCleaned: orphanedProcInfo.changes,
      staleLeasesCleared: staleLeasesInfo.changes,
      recoveredAt: now,
      executionRecovery: executionRecoveryReport,
    };

    const allProjects = this.repo.getAllProjects();
    for (const proj of allProjects) {
      this.eventService.record(
        proj.id,
        'SYSTEM_STARTUP_RECOVERY',
        `Startup recovery complete. Reconciled ${report.orphanedProcessesCleaned} orphaned process runs, ${report.staleLeasesCleared} stale leases, and scanned ${executionRecoveryReport.scannedCount} execution authorizations (${executionRecoveryReport.reconciledCount} reconciled, ${executionRecoveryReport.unresolvedCount} unresolved, ${executionRecoveryReport.rejectedCount} rejected, ${executionRecoveryReport.noOpCount} no-op).`,
        report as unknown as Record<string, unknown>
      );
    }

    console.log('[CrashRecovery] Startup recovery completed successfully.', report);
    return report;
  }
}
