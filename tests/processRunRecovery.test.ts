import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { CrashRecoveryService } from '../src/core/services/CrashRecoveryService';
import { ProcessRunRecoveryScanner, computeProcessRunIdentityHash } from '../src/core/services/ProcessRunRecoveryScanner';
import { ProcessRunner } from '../src/core/services/ProcessRunner';

function seedRun(db: Database.Database, input: { id: string; pid: number | null; taskId?: string; startTime?: string }): void {
  db.prepare(`
    INSERT INTO process_runs (
      id, pid, project_id, task_id, attempt_id, command, working_directory,
      status, start_time, end_time, exit_code, stdout_evidence_id, stderr_evidence_id, created_at
    ) VALUES (?, ?, NULL, ?, NULL, ?, ?, 'RUNNING', ?, NULL, NULL, NULL, NULL, ?)
  `).run(
    input.id,
    input.pid,
    input.taskId ?? null,
    'node worker.js',
    'C:/agent-forge/worktree',
    input.startTime ?? '2026-09-27T00:00:00.000Z',
    input.startTime ?? '2026-09-27T00:00:00.000Z',
  );
}

describe('ProcessRunRecoveryScanner', () => {
  it('keeps live, missing, dead, and unknown PID rows RUNNING and recovery-fenced', () => {
    const db = new Database(':memory:');
    MigrationRunner.run(db);
    seedRun(db, { id: 'run-live', pid: 101 });
    seedRun(db, { id: 'run-missing', pid: null });
    seedRun(db, { id: 'run-dead', pid: 103 });
    seedRun(db, { id: 'run-unknown', pid: 104 });

    const scanner = new ProcessRunRecoveryScanner(db, {
      observeProcess: (pid) => {
        if (pid === 101) return 'LIVE';
        if (pid === 103) return 'DEAD';
        return 'UNKNOWN';
      },
      now: () => '2026-09-27T01:00:00.000Z',
    });
    const report = scanner.scanAndReconcile();

    expect(report.scannedCount).toBe(4);
    expect(report.unresolvedCount).toBe(4);
    expect(report.livePidCount).toBe(1);
    expect(report.missingPidCount).toBe(1);
    expect(report.deadPidCount).toBe(1);
    expect(report.unknownPidCount).toBe(1);
    expect(report.items.map((item) => item.classification)).toEqual([
      'DEAD_PID_UNRESOLVED',
      'LIVE_PID_UNRESOLVED',
      'MISSING_PID_UNRESOLVED',
      'PID_STATE_UNKNOWN_UNRESOLVED',
    ]);
    expect(report.items.every((item) => item.disposition === 'UNRESOLVED_FENCED')).toBe(true);
    expect(db.prepare("SELECT id, status FROM process_runs ORDER BY start_time, id").all()).toEqual([
      { id: 'run-dead', status: 'RUNNING' },
      { id: 'run-live', status: 'RUNNING' },
      { id: 'run-missing', status: 'RUNNING' },
      { id: 'run-unknown', status: 'RUNNING' },
    ]);
    db.close();
  });

  it('uses a stable identity hash across repeated restart scans', () => {
    const db = new Database(':memory:');
    MigrationRunner.run(db);
    seedRun(db, { id: 'run-stable', pid: null });
    const scanner = new ProcessRunRecoveryScanner(db, { now: () => '2026-09-27T01:00:00.000Z' });
    const first = scanner.scanAndReconcile().items[0];
    const second = new ProcessRunRecoveryScanner(db, { now: () => '2026-09-27T02:00:00.000Z' }).scanAndReconcile().items[0];

    expect(first.identityHash).toBe(second.identityHash);
    expect(first.identityHash).toBe(computeProcessRunIdentityHash({
      executionId: 'run-stable',
      pid: null,
      command: 'node worker.js',
      workingDirectory: 'C:/agent-forge/worktree',
      startTime: '2026-09-27T00:00:00.000Z',
    }));
    db.close();
  });

  it('probes current PID as live and treats a non-ESRCH probe failure as unknown', () => {
    expect(ProcessRunner.observeProcessLiveness(process.pid)).toBe('LIVE');
    expect(ProcessRunner.observeProcessLiveness(0)).toBe('UNKNOWN');
  });

  it('does not claim cancellation during startup recovery when a prior run is uncertain', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    seedRun(db, { id: 'run-restart', pid: null });

    const repo = new Repository(db);
    const report = new CrashRecoveryService(db, repo, new EventService(repo)).performStartupRecovery();

    expect(report.orphanedProcessesCleaned).toBe(0);
    expect(report.processRecovery.scannedCount).toBe(1);
    expect(report.processRecovery.unresolvedCount).toBe(1);
    expect(repo.getProcessRun('run-restart')?.status).toBe('RUNNING');
    db.close();
  });

  it('does not let an expired task lease be reacquired while its process row is still RUNNING', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    const repo = new Repository(db);
    const now = new Date().toISOString();
    repo.createProject({
      id: 'project-recovery-fence',
      name: 'Recovery Fence',
      description: null,
      repository_path: 'C:/agent-forge',
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
    });
    repo.createTask({
      id: 'task-recovery-fence',
      project_id: 'project-recovery-fence',
      milestone_id: null,
      title: 'Recovery fence',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'HIGH',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      ownership_epoch: 1,
      created_at: now,
      updated_at: now,
    });
    db.prepare(`
      INSERT INTO task_leases (task_id, agent_id, lease_token, acquired_at, expires_at, heartbeat_at, released_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run('task-recovery-fence', 'worker-old', 'token-old', now, '2020-01-01T00:00:00.000Z', now);
    seedRun(db, { id: 'run-task-fence', pid: null, taskId: 'task-recovery-fence' });

    expect(repo.acquireTaskLease('task-recovery-fence', 'worker-new', 'token-new')).toBe(false);
    expect(repo.getTaskLease('task-recovery-fence')?.lease_token).toBe('token-old');
    db.close();
  });
});
