import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { AutonomyState } from './contracts';
import type { AutonomyStore, AutonomyWorkOrderRow } from './store';
import { buildTrustedEnvironment, resolveTrustedExecutable } from '../services/ExecutableResolver';

/**
 * The recovery scanner deliberately has no write capability.  It reads the
 * durable autonomy rows and Git's worktree inventory, then returns a bounded
 * report which the Supervisor can use to decide which rows may be released.
 *
 * Keeping the scanner read-only is important: a restart must never repair,
 * delete, unlock, or reuse a worktree merely because it appears in a stale
 * database row.  Any disagreement is therefore reported as a fence and is
 * left for an explicit, authorized attempt to resolve.
 */

export type RecoveryWorktreeClassification =
  | 'MATCHED'
  | 'MISSING'
  | 'PATH_OUTSIDE_MANAGED_ROOT'
  | 'PATH_IS_MANAGED_ROOT'
  | 'NOT_REGISTERED'
  | 'GIT_TOP_LEVEL_MISMATCH'
  | 'BRANCH_MISMATCH'
  | 'HEAD_MISMATCH'
  | 'DIRTY'
  | 'GIT_INSPECTION_FAILED'
  | 'ORPHANED_WORKTREE';

export interface RecoveryWorktreeInspection {
  workOrderId: string | null;
  taskId: string | null;
  state: AutonomyState | null;
  worktree: string;
  expectedBranch: string | null;
  expectedHeadSha: string | null;
  pathContained: boolean;
  exists: boolean;
  registered: boolean;
  gitTopLevel: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  classification: RecoveryWorktreeClassification;
  fenced: boolean;
  retain: boolean;
  details?: string;
}
export interface AutonomyRecoveryReport {
  generatedAt: string;
  managedRoot: string;
  repositoryRoot: string;
  scannedWorkOrders: number;
  scannedSlots: number;
  activeWorkOrders: string[];
  activeSlots: string[];
  inspections: RecoveryWorktreeInspection[];
  mismatches: RecoveryWorktreeInspection[];
  retained: RecoveryWorktreeInspection[];
  orphaned: RecoveryWorktreeInspection[];
  scanError: string | null;
}

export interface AutonomyRecoveryScannerConfig {
  controlRepo: string;
  worktreeRoot: string;
  gitExecutable?: string;
  /** Test hook; production uses spawnSync with shell disabled. */
  runGit?: (args: string[], cwd: string) => { exitCode: number; stdout: string; stderr: string };
}

interface GitWorktreeInventoryEntry {
  worktree: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
}

const TERMINAL_STATES = new Set<AutonomyState>(['MERGED', 'BLOCKED', 'FAILED']);
const RETAINED_STATES = new Set<AutonomyState>(['CI_WAIT', 'PR_OPEN', 'MERGE_READY']);

function normalizePathForComparison(candidate: string): string {
  let resolved = path.resolve(candidate);
  // Resolve the nearest existing ancestor as well as existing leaves.  On
  // Windows a missing worktree can be represented with an 8.3 alias while
  // the managed root resolves to its long spelling; comparing those raw
  // strings would incorrectly classify an in-root missing path as outside.
  const suffix: string[] = [];
  while (!fs.existsSync(resolved)) {
    const parent = path.dirname(resolved);
    if (parent === resolved) break;
    suffix.unshift(path.basename(resolved));
    resolved = parent;
  }
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    }
  } catch {
    // A missing path is still checked lexically below.  Failure to resolve a
    // path must never turn a containment failure into a match.
  }
  resolved = path.resolve(resolved, ...suffix);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isContained(candidate: string, root: string): boolean {
  const child = normalizePathForComparison(candidate);
  const parent = normalizePathForComparison(root);
  if (child === parent) return false;
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeSha(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : normalized || null;
}

function normalizeBranch(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^refs\/heads\//, '');
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Read-only reconciliation for the legacy Supervisor autonomy tables.
 * Product-task state remains owned by its product lease/recovery services and
 * is intentionally not inferred from these compatibility rows.
 */
export class AutonomyRecoveryScanner {
  private readonly store: AutonomyStore;
  private readonly controlRepo: string;
  private readonly worktreeRoot: string;
  private readonly gitExecutable: string;
  private readonly runGit: (args: string[], cwd: string) => { exitCode: number; stdout: string; stderr: string };

  constructor(store: AutonomyStore, config: AutonomyRecoveryScannerConfig) {
    this.store = store;
    this.controlRepo = path.resolve(config.controlRepo);
    this.worktreeRoot = path.resolve(config.worktreeRoot);
    const requestedGit = config.gitExecutable ?? process.env.GIT_EXECUTABLE ?? 'git';
    this.gitExecutable = resolveTrustedExecutable(requestedGit, 'git') ?? '';
    this.runGit = config.runGit ?? ((args, cwd) => {
      if (!this.gitExecutable) {
        return { exitCode: 1, stdout: '', stderr: 'GIT_EXECUTABLE_NOT_FOUND' };
      }
      const result = spawnSync(this.gitExecutable, args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: buildTrustedEnvironment({ env: process.env }),
      });
      return {
        exitCode: result.status === null ? 1 : result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
      };
    });
  }

  /**
   * Produce a report without changing SQLite, Git, or the filesystem.
   * Repeated calls against an unchanged workspace are observationally stable
   * apart from generatedAt.
   */
  inspect(): AutonomyRecoveryReport {
    const activeSlots = this.store.listActiveSlots();
    const allOrders = this.store.listAll();
    const activeSlotOrderIds = new Set(activeSlots.map((slot) => slot.workOrderId));
    // Include a terminal row which still owns an active slot.  A previous
    // recovery may have fenced that row before a crash interrupted slot
    // release; dropping it from the next report would make the ambiguous
    // worktree look orphaned and could permit unsafe reuse.
    const activeOrders = allOrders.filter((row) => !TERMINAL_STATES.has(row.state) || activeSlotOrderIds.has(row.id));
    const inspections: RecoveryWorktreeInspection[] = [];
    let scanError: string | null = null;

    let inventory: GitWorktreeInventoryEntry[] = [];
    try {
      inventory = this.listInventory();
    } catch (error) {
      scanError = error instanceof Error ? error.message : String(error);
    }

    const expectedPaths = new Set(activeOrders.map((row) => normalizePathForComparison(row.worktree)));
    for (const row of activeOrders) {
      const expectedHeadSha = this.expectedHeadSha(row);
      inspections.push(this.inspectOrder(row, expectedHeadSha, inventory, scanError));
    }

    // A slot can outlive a WorkOrder if a crash occurred between durable
    // lease assignment and WorkOrder insertion/rollback.  Surface that
    // impossible ownership tuple as a fenced report item instead of silently
    // dropping it from the operator view.
    const knownOrderIds = new Set(activeOrders.map((row) => row.id));
    for (const slot of activeSlots) {
      if (knownOrderIds.has(slot.workOrderId)) continue;
      inspections.push({
        workOrderId: slot.workOrderId,
        taskId: null,
        state: null,
        worktree: '',
        expectedBranch: null,
        expectedHeadSha: null,
        pathContained: false,
        exists: false,
        registered: false,
        gitTopLevel: null,
        branch: null,
        headSha: null,
        dirty: null,
        classification: 'GIT_INSPECTION_FAILED',
        fenced: true,
        retain: true,
        details: `Active slot ${slot.slotId} references a missing durable WorkOrder; no release was attempted.`,
      });
    }

    // A Git worktree under the managed root which has no non-terminal durable
    // owner is an orphan.  It is reported for an operator; it is never pruned
    // or removed during recovery.
    for (const entry of inventory) {
      if (!isContained(entry.worktree, this.worktreeRoot)) continue;
      if (normalizePathForComparison(entry.worktree) === normalizePathForComparison(this.controlRepo)) continue;
      if (expectedPaths.has(normalizePathForComparison(entry.worktree))) continue;
      const orphan = this.inspectInventoryEntry(entry);
      orphan.classification = 'ORPHANED_WORKTREE';
      orphan.fenced = true;
      orphan.retain = true;
      inspections.push(orphan);
    }

    const mismatches = inspections.filter((inspection) => inspection.fenced);
    const retained = inspections.filter((inspection) => inspection.retain && !inspection.fenced);
    const orphaned = inspections.filter((inspection) => inspection.classification === 'ORPHANED_WORKTREE');
    return {
      generatedAt: new Date().toISOString(),
      managedRoot: this.worktreeRoot,
      repositoryRoot: this.controlRepo,
      scannedWorkOrders: activeOrders.length,
      scannedSlots: activeSlots.length,
      activeWorkOrders: activeOrders.map((row) => row.id),
      activeSlots: activeSlots.map((slot) => slot.slotId),
      inspections,
      mismatches,
      retained,
      orphaned,
      scanError,
    };
  }

  private listInventory(): GitWorktreeInventoryEntry[] {
    const result = this.runGit(['worktree', 'list', '--porcelain'], this.controlRepo);
    if (result.exitCode !== 0) {
      throw new Error(`RECOVERY_GIT_INVENTORY_FAILED: ${result.stderr.trim() || result.stdout.trim() || 'git worktree list failed'}`);
    }
    const entries: GitWorktreeInventoryEntry[] = [];
    let current: Partial<GitWorktreeInventoryEntry> | null = null;
    const flush = () => {
      if (current?.worktree) {
        entries.push({
          worktree: current.worktree,
          headSha: normalizeSha(current.headSha),
          branch: normalizeBranch(current.branch),
          detached: current.detached ?? false,
          prunable: current.prunable ?? false,
        });
      }
      current = null;
    };
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      if (trimmed.startsWith('worktree ')) {
        flush();
        current = { worktree: trimmed.substring('worktree '.length).trim(), detached: false, prunable: false };
      } else if (trimmed.startsWith('HEAD ') && current) {
        current.headSha = trimmed.substring('HEAD '.length).trim();
      } else if (trimmed.startsWith('branch ') && current) {
        current.branch = trimmed.substring('branch '.length).trim();
      } else if (trimmed === 'detached' && current) {
        current.detached = true;
      } else if (trimmed.startsWith('prunable') && current) {
        current.prunable = true;
      }
    }
    flush();
    return entries;
  }

  private expectedHeadSha(row: AutonomyWorkOrderRow): string | null {
    // CI/PR state is tied to the exact observed remote head, which can differ
    // from the original base SHA after the Supervisor publishes an accepted
    // repair.  All other states must still be at the WorkOrder base SHA.
    if (RETAINED_STATES.has(row.state)) {
      const watch = this.store.getDatabase().prepare(`
        SELECT expected_head_sha FROM autonomy_ci_watches
        WHERE work_order_id = ? OR task_id = ?
        ORDER BY updated_at DESC, created_at DESC LIMIT 1
      `).get(row.id, row.task_id) as { expected_head_sha?: string } | undefined;
      if (watch?.expected_head_sha) return normalizeSha(watch.expected_head_sha);
      const claim = this.store.getDatabase().prepare(`
        SELECT head_sha FROM autonomy_claims
        WHERE work_order_id = ? AND head_sha IS NOT NULL
        ORDER BY observed_at DESC LIMIT 1
      `).get(row.id) as { head_sha?: string } | undefined;
      if (claim?.head_sha) return normalizeSha(claim.head_sha);
    }
    return normalizeSha(row.base_sha);
  }

  private inspectOrder(
    row: AutonomyWorkOrderRow,
    expectedHeadSha: string | null,
    inventory: GitWorktreeInventoryEntry[],
    scanError: string | null,
  ): RecoveryWorktreeInspection {
    const candidate = path.resolve(row.worktree);
    const pathContained = isContained(candidate, this.worktreeRoot);
    const exists = fs.existsSync(candidate);
    const inventoryEntry = inventory.find((entry) => normalizePathForComparison(entry.worktree) === normalizePathForComparison(candidate));
    const base: RecoveryWorktreeInspection = {
      workOrderId: row.id,
      taskId: row.task_id,
      state: row.state,
      worktree: candidate,
      expectedBranch: normalizeBranch(row.branch),
      expectedHeadSha,
      pathContained,
      exists,
      registered: !!inventoryEntry,
      gitTopLevel: null,
      branch: inventoryEntry?.branch ?? null,
      headSha: inventoryEntry?.headSha ?? null,
      dirty: null,
      classification: 'GIT_INSPECTION_FAILED',
      fenced: true,
      retain: true,
    };

    if (!pathContained) {
      base.classification = normalizePathForComparison(candidate) === normalizePathForComparison(this.worktreeRoot)
        ? 'PATH_IS_MANAGED_ROOT'
        : 'PATH_OUTSIDE_MANAGED_ROOT';
      base.details = 'WorkOrder path is not a strict child of the configured managed worktree root.';
      return base;
    }
    if (!exists) {
      base.classification = 'MISSING';
      base.details = 'Managed worktree path does not exist.';
      return base;
    }
    if (scanError) {
      base.classification = 'GIT_INSPECTION_FAILED';
      base.details = scanError;
      return base;
    }
    if (!inventoryEntry) {
      base.classification = 'NOT_REGISTERED';
      base.details = 'Path exists but is not registered in git worktree list.';
      return base;
    }

    const topLevel = this.gitValue(['rev-parse', '--show-toplevel'], candidate);
    if (topLevel === null) {
      base.classification = 'GIT_INSPECTION_FAILED';
      base.details = 'Unable to read Git top-level.';
      return base;
    }
    base.gitTopLevel = topLevel?.trim() ? path.resolve(topLevel.trim()) : null;
    if (!base.gitTopLevel || normalizePathForComparison(base.gitTopLevel) !== normalizePathForComparison(candidate)) {
      base.classification = 'GIT_TOP_LEVEL_MISMATCH';
      base.details = 'Git top-level does not exactly match the durable worktree path.';
      return base;
    }
    const branch = this.gitValue(['branch', '--show-current'], candidate);
    if (branch === null) {
      base.classification = 'GIT_INSPECTION_FAILED';
      base.details = 'Unable to read Git branch.';
      return base;
    }
    base.branch = normalizeBranch(branch);
    const head = this.gitValue(['rev-parse', 'HEAD'], candidate);
    if (head === null) {
      base.classification = 'GIT_INSPECTION_FAILED';
      base.details = 'Unable to read Git HEAD.';
      return base;
    }
    base.headSha = normalizeSha(head);
    const status = this.gitValue(['status', '--porcelain', '-uall'], candidate);
    if (status === null) {
      base.classification = 'GIT_INSPECTION_FAILED';
      base.details = 'Unable to read Git status.';
      return base;
    }
    base.dirty = status.trim().length > 0;
    if (base.branch !== base.expectedBranch) {
      base.classification = 'BRANCH_MISMATCH';
      base.details = `Expected branch ${safeJsonString(base.expectedBranch)}, observed ${safeJsonString(base.branch)}.`;
      return base;
    }
    if (expectedHeadSha && base.headSha !== expectedHeadSha) {
      base.classification = 'HEAD_MISMATCH';
      base.details = `Expected HEAD ${expectedHeadSha}, observed ${base.headSha ?? 'null'}.`;
      return base;
    }
    if (base.dirty) {
      base.classification = 'DIRTY';
      base.details = 'Managed worktree contains uncommitted or untracked changes.';
      return base;
    }
    base.classification = 'MATCHED';
    base.fenced = false;
    base.retain = RETAINED_STATES.has(row.state);
    return base;
  }

  private inspectInventoryEntry(entry: GitWorktreeInventoryEntry): RecoveryWorktreeInspection {
    const candidate = path.resolve(entry.worktree);
    const status = fs.existsSync(candidate) ? this.gitValue(['status', '--porcelain', '-uall'], candidate) : null;
    return {
      workOrderId: null,
      taskId: null,
      state: null,
      worktree: candidate,
      expectedBranch: null,
      expectedHeadSha: null,
      pathContained: isContained(candidate, this.worktreeRoot),
      exists: fs.existsSync(candidate),
      registered: true,
      gitTopLevel: candidate,
      branch: entry.branch,
      headSha: entry.headSha,
      dirty: status === null ? null : status.trim().length > 0,
      classification: 'ORPHANED_WORKTREE',
      fenced: true,
      retain: true,
      details: 'Managed Git worktree has no active durable autonomy owner; no cleanup was attempted.',
    };
  }

  private gitValue(args: string[], cwd: string): string | null {
    const result = this.runGit(args, cwd);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }
}
