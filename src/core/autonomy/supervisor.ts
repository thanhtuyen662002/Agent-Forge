import fs from 'fs';
import path from 'path';
import { EvidenceCollector } from './evidence';
import { AntigravityAdapter, CodexManagerAdapter, ManagerEvidence, ProviderRun } from './providers';
import { AutonomyState, AutonomousTaskSpec, ManagerReview, WorkOrder, createWorkOrder } from './contracts';
import { AutonomyStore } from './store';
import { Repository } from '../database/repositories';
import { ProcessRunner } from '../services/ProcessRunner';
import { assertPathContained } from '../services/ArtifactStore';
import { ManagerProviderPool } from './managerPool';

export type AutonomyMode = 'SHADOW' | 'PILOT' | 'AUTONOMOUS';

export interface SupervisorConfig {
  mode?: AutonomyMode;
  maxWorkers?: number;
  maxRepairLoops?: number;
  runtimeRoot?: string;
  agy?: AntigravityAdapter;
  manager?: CodexManagerAdapter;
  managerPool?: ManagerProviderPool;
  evidence?: Pick<EvidenceCollector, 'collect'>;
  store?: AutonomyStore;
  controlRepo?: string;
  worktreeRoot?: string;
}

export interface SupervisorRunResult {
  workOrder: WorkOrder;
  state: AutonomyState;
  provider?: ProviderRun;
  review?: ManagerReview;
  headSha?: string;
  repairLoops: number;
  error?: string;
  accepted?: boolean;
}

export class AutonomySupervisor {
  readonly mode: AutonomyMode;
  readonly maxWorkers: number;
  readonly maxRepairLoops: number;
  readonly store: AutonomyStore;
  readonly agy: AntigravityAdapter;
  readonly manager: CodexManagerAdapter;
  readonly managerPool: ManagerProviderPool;
  readonly evidence: Pick<EvidenceCollector, 'collect'>;
  readonly controlRepo: string;
  readonly worktreeRoot: string;

  constructor(config: SupervisorConfig = {}) {
    this.mode = config.mode ?? ((process.env.AGENT_FORGE_MODE as AutonomyMode | undefined) ?? 'PILOT');
    this.maxWorkers = config.maxWorkers ?? Number(process.env.MAX_AGY_WORKERS ?? 1);
    this.maxRepairLoops = config.maxRepairLoops ?? Number(process.env.MAX_REPAIR_LOOPS ?? 3);
    this.controlRepo = path.resolve(config.controlRepo ?? process.env.AGENT_FORGE_CONTROL_REPO ?? process.cwd());
    this.worktreeRoot = path.resolve(config.worktreeRoot ?? process.env.AGENT_FORGE_WORKTREE_ROOT ?? path.join(this.controlRepo, '..', 'AI', 'Agent-Forge-Worktrees'));
    this.store = config.store ?? AutonomyStore.open(config.runtimeRoot ?? (process.env.AGENT_FORGE_RUNTIME_ROOT ?? path.join(this.controlRepo, '..', 'AI', 'Agent-Forge-Runtime'))).store;
    const repo = new Repository(this.store.getDatabase());
    const runner: typeof ProcessRunner.execute = (options) => ProcessRunner.execute({ ...options, repo });
    this.agy = config.agy ?? new AntigravityAdapter({ runner });
    this.manager = config.manager ?? new CodexManagerAdapter({ runner });
    this.managerPool = config.managerPool ?? ManagerProviderPool.fromEnvironment(this.store, this.manager);
    this.evidence = config.evidence ?? new EvidenceCollector({ execute: runner });
    this.store.ensureSlots(this.maxWorkers);
  }

  createWorkOrder(spec: AutonomousTaskSpec): WorkOrder {
    const order = createWorkOrder(spec);
    if (!path.isAbsolute(order.worktree)) throw new Error('CONTRACT_INVALID: worktree must be absolute');
    if (path.resolve(order.worktree).toLowerCase() === this.controlRepo.toLowerCase()) throw new Error('WORKTREE_IS_CONTROL_REPO: workers cannot run in the control repository');
    if (this.mode !== 'SHADOW') {
      assertPathContained(order.worktree, this.worktreeRoot);
      if (!AutonomySupervisor.isSafeWorktree(this.controlRepo, order.worktree)) throw new Error('UNSAFE_WORKTREE');
      if (!order.allowed_paths.length || !order.required_tests.length) throw new Error('CONTRACT_INVALID: allowed paths and deterministic tests are required');
      for (const entry of order.allowed_paths) assertPathContained(path.resolve(order.worktree, entry), order.worktree);
    }
    return order;
  }

  async run(spec: AutonomousTaskSpec): Promise<SupervisorRunResult> {
    let order = this.createWorkOrder(spec);
    if (this.mode === 'SHADOW') return { workOrder: order, state: 'READY', repairLoops: 0 };
    let row;
    try {
      row = this.store.createWorkOrder(order);
    } catch (error) {
      return { workOrder: order, state: 'FAILED', repairLoops: 0, error: error instanceof Error ? error.message : String(error) };
    }
    let slot;
    try {
      slot = this.store.acquireSlot(row.id, order.worker_id, order.lease_epoch);
      this.store.updateState(row.id, 'IMPLEMENTING', order.lease_epoch);
    } catch (error) {
      return { workOrder: order, state: 'READY', repairLoops: 0, error: error instanceof Error ? error.message : String(error) };
    }

    let repairLoops = 0;
    try {
      const initial = await this.evidence.collect(order, []);
      if (initial.headSha !== order.base_sha || initial.status.trim()) throw new Error('WORKTREE_BASE_OR_CLEANLINESS_MISMATCH');
      while (true) {
        const provider = await this.agy.execute(order);
        this.store.recordRun(row.id, 'antigravity', provider);
        if (provider.status !== 'SUCCESSFUL_PROCESS_EXIT') {
          const failedState: AutonomyState = provider.status === 'AUTH_ERROR' || provider.status === 'QUOTA_OR_RATE_LIMIT' ? 'BLOCKED' : 'FAILED';
          this.store.updateState(row.id, failedState, order.lease_epoch);
          return { workOrder: order, state: failedState, provider, repairLoops, error: provider.error ?? provider.stderr };
        }
        this.store.updateState(row.id, 'LOCAL_VERIFY', order.lease_epoch);
        const evidence = await this.evidence.collect(order, order.required_tests);
        this.store.event(row.id, 'VERIFICATION_EVIDENCE', evidence);
        if (evidence.headSha !== order.base_sha) throw new Error('WORKER_CHANGED_HEAD: supervisor owns commits');
        const allowed = (name: string) => order.allowed_paths.some((entry) => name === entry || name.startsWith(`${entry.replace(/\/$/, '')}/`));
        if (evidence.changedFiles.some((name) => !allowed(name) || order.forbidden_paths.some((entry) => name === entry || name.startsWith(`${entry}/`)))) throw new Error('WORKER_PATH_VIOLATION');
        this.store.updateState(row.id, 'MANAGER_REVIEW', order.lease_epoch);
        const reviewResult = await this.managerPool.review({
          protocol_version: 'managercontext.v1',
          task_identity: { task_id: order.task_id, attempt: order.attempt, worker_id: order.worker_id },
          work_order: order, acceptance_criteria: order.acceptance_criteria, base_sha: order.base_sha,
          current_head: evidence.headSha, actual_diff: evidence.diff, changed_files: evidence.changedFiles,
          deterministic_tests: evidence.tests,
          previous_manager_decisions: this.store.getDatabase().prepare('SELECT payload_json FROM autonomy_reviews WHERE work_order_id=? ORDER BY created_at').all(row.id),
          repair_history: this.store.getDatabase().prepare("SELECT payload_json FROM autonomy_events WHERE work_order_id=? AND event_type='REPAIR_REQUIRED' ORDER BY created_at").all(row.id),
          pr_state: this.store.getDatabase().prepare('SELECT * FROM autonomy_claims WHERE work_order_id=?').all(row.id),
          ci_state: this.store.getDatabase().prepare('SELECT * FROM autonomy_ci_watches WHERE work_order_id=?').all(row.id),
          architecture_policy_context: ['Supervisor owns leases, worktrees, GitHub, and verification.', 'PASS requires a fresh exact HEAD match.'],
        });
        this.store.recordRun(row.id, 'codex-review', reviewResult.run);
        if (!reviewResult.review) {
          if (reviewResult.run.stderr === 'ALL_MANAGER_RESOURCES_UNAVAILABLE') {
            // Capacity is a durable provider-resource condition, not a task
            // failure. Keep the task resumable and release the implementation
            // slot in finally so independent work can continue.
            this.store.event(row.id, 'MANAGER_CAPACITY_UNAVAILABLE', { attempts: reviewResult.attempts, contextSha: reviewResult.context_sha });
            return { workOrder: order, state: 'MANAGER_REVIEW', provider, repairLoops, error: 'MANAGER_CAPACITY_UNAVAILABLE' };
          }
          this.store.updateState(row.id, 'FAILED', order.lease_epoch);
          return { workOrder: order, state: 'FAILED', provider, repairLoops, error: reviewResult.run.error ?? reviewResult.run.stderr };
        }
        const review = reviewResult.review;
        this.store.recordReview(row.id, review);
        const currentEvidence = await this.evidence.collect(order, []);
        const verified = evidence.tests.length === order.required_tests.length && evidence.tests.length > 0 && evidence.tests.every((test) => test.exitCode === 0);
        const fresh = review.reviewed_head_sha === currentEvidence.headSha && evidence.snapshotSha !== undefined && evidence.snapshotSha === currentEvidence.snapshotSha;
        if (review.verdict === 'PASS' && fresh && verified) {
          this.store.event(row.id, 'LOCAL_ACCEPTED', { headSha: currentEvidence.headSha, snapshotSha: currentEvidence.snapshotSha });
          return { workOrder: order, state: 'MANAGER_REVIEW', accepted: true, provider, review, headSha: currentEvidence.headSha, repairLoops };
        }
        if (review.verdict === 'BLOCKED') {
          this.store.updateState(row.id, 'BLOCKED', order.lease_epoch);
          return { workOrder: order, state: 'BLOCKED', provider, review, headSha: currentEvidence.headSha, repairLoops };
        }
        repairLoops += 1;
        if (repairLoops > this.maxRepairLoops) {
          this.store.updateState(row.id, 'BLOCKED', order.lease_epoch);
          return { workOrder: order, state: 'BLOCKED', provider, review, headSha: currentEvidence.headSha, repairLoops, error: 'MAX_REPAIR_LOOPS_EXCEEDED' };
        }
        this.store.event(row.id, 'REPAIR_REQUIRED', { review, verified, fresh });
        this.store.releaseSlot(slot.slotId, row.id, order.lease_epoch);
        this.store.updateState(row.id, 'FAILED', order.lease_epoch);
        order = { ...order, attempt: order.attempt + 1, lease_epoch: order.lease_epoch + 1, constraints: [...order.constraints, `Repair findings: ${JSON.stringify(review.findings)}. Required actions: ${JSON.stringify(review.required_actions)}. Tests passed: ${verified}. Review fresh: ${fresh}.`] };
        row = this.store.createWorkOrder(order);
        slot = this.store.acquireSlot(row.id, order.worker_id, order.lease_epoch);
        this.store.updateState(row.id, 'IMPLEMENTING', order.lease_epoch);
      }
    } catch (error) {
      this.store.updateState(row.id, 'BLOCKED', order.lease_epoch);
      return { workOrder: order, state: 'BLOCKED', repairLoops, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (slot) {
        try { this.store.releaseSlot(slot.slotId, row.id, order.lease_epoch); } catch { /* recovery scanner will fence this slot */ }
      }
    }
  }

  markCiWait(workOrderId: string, leaseEpoch: number): void {
    this.store.updateState(workOrderId, 'CI_WAIT', leaseEpoch);
    for (const slot of this.store.listActiveSlots().filter((candidate) => candidate.workOrderId === workOrderId && candidate.leaseEpoch === leaseEpoch)) {
      this.store.releaseSlot(slot.slotId, workOrderId, leaseEpoch);
    }
  }

  recover(): { releasedSlots: number; fencedOrders: number } {
    let releasedSlots = 0;
    let fencedOrders = 0;
    const uncertain = this.store.getDatabase().prepare("SELECT id,pid FROM process_runs WHERE status='RUNNING'").all() as Array<{id:string;pid:number|null}>;
    if (uncertain.length) {
      // A missing/dead direct PID cannot prove that grandchildren exited.
      // Retain all leases until process-tree termination is proven.
      throw new Error(`RECOVERY_PROCESS_FENCED: ${uncertain.length} unsettled process records; no dispatch permitted`);
    }
    for (const slot of this.store.listActiveSlots()) {
      const order = this.store.getWorkOrder(slot.workOrderId);
      if (order && !['CI_WAIT', 'PR_OPEN', 'MERGED', 'BLOCKED', 'FAILED'].includes(order.state)) {
        this.store.updateState(order.id, 'BLOCKED', order.lease_epoch);
        this.store.event(order.id, 'RECOVERY_FENCED', { reason: 'Interrupted attempt retained; requires a new authorized attempt' });
        fencedOrders += 1;
      }
      try { this.store.releaseSlot(slot.slotId, slot.workOrderId, slot.leaseEpoch); releasedSlots += 1; } catch { fencedOrders += 1; }
    }
    return { releasedSlots, fencedOrders };
  }

  static isSafeWorktree(controlRepo: string, worktree: string): boolean {
    const controlResolved = path.resolve(controlRepo);
    const candidateResolved = path.resolve(worktree);
    // Resolve the filesystem using the original spelling. Lowercasing before
    // existsSync breaks POSIX paths with mixed-case temp directory names.
    if (!fs.existsSync(candidateResolved)) return false;
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const control = normalize(controlResolved);
    const candidate = normalize(candidateResolved);
    const relative = path.relative(control, candidate);
    return candidate !== control && (relative.startsWith('..') || path.isAbsolute(relative));
  }
}
