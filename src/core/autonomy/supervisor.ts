import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { EvidenceCollector } from './evidence';
import { AntigravityAdapter, CodexManagerAdapter, ManagerEvidence, ProviderRun } from './providers';
import { AutonomyState, AutonomousTaskSpec, ManagerReview, SelfHostTask, WorkOrder, createWorkOrder } from './contracts';
import { AutonomyStore } from './store';
import { Repository } from '../database/repositories';
import { ProcessRunner } from '../services/ProcessRunner';
import { assertPathContained, ArtifactStore } from '../services/ArtifactStore';
import { ManagerProviderPool, buildManagerContextPackage } from './managerPool';
import { ProductTaskAutonomyAdapter, renderCommand } from './productTaskAdapter';
import { GitWorktreeService } from '../services/GitWorktreeService';
import { AgentAssignment, ExecutionAuthorization, Task } from '../types/domain';
import { CanonicalExecutionPayload, CanonicalExecutionPayloadSchema } from '../services/ExecutionAuthorizationService';
import { ProviderEndpointConfig } from './providerEndpoint';
import { loadOmniRouteEndpointFromEnvironment } from './responsesEndpoint';
import {
  CoderResourceBinding,
  ResponsesCoderEndpointTransport,
  applyCoderEditBundle,
  resolveCoderProvider,
} from './responsesCoderEndpoint';

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
  productAdapter?: ProductTaskAutonomyAdapter;
  coderTransport?: ResponsesCoderEndpointTransport;
  coderEndpoint?: ProviderEndpointConfig | null;
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
  readonly productAdapter: ProductTaskAutonomyAdapter;
  readonly coderTransport: ResponsesCoderEndpointTransport;
  readonly coderEndpoint: ProviderEndpointConfig | null;

  constructor(config: SupervisorConfig = {}) {
    this.mode = config.mode ?? ((process.env.AGENT_FORGE_MODE as AutonomyMode | undefined) ?? 'PILOT');
    const rawWorkers = config.maxWorkers ?? (process.env.MAX_AGY_WORKERS !== undefined ? Number(process.env.MAX_AGY_WORKERS) : 1);
    if (!Number.isInteger(rawWorkers) || rawWorkers < 1 || rawWorkers > 2) {
      throw new Error('CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS_BOUNDS: AutonomySupervisor accepts only MAX_AGY_WORKERS integers from 1 through 2');
    }
    this.maxWorkers = rawWorkers;
    this.maxRepairLoops = config.maxRepairLoops ?? Number(process.env.MAX_REPAIR_LOOPS ?? 3);
    this.controlRepo = path.resolve(config.controlRepo ?? process.env.AGENT_FORGE_CONTROL_REPO ?? process.cwd());
    this.worktreeRoot = path.resolve(config.worktreeRoot ?? process.env.AGENT_FORGE_WORKTREE_ROOT ?? path.join(this.controlRepo, '..', 'AI', 'Agent-Forge-Worktrees'));
    const runtimeRoot = config.runtimeRoot ?? (process.env.AGENT_FORGE_RUNTIME_ROOT ?? path.join(this.controlRepo, '..', 'AI', 'Agent-Forge-Runtime'));
    this.store = config.store ?? AutonomyStore.open(runtimeRoot).store;
    const repo = new Repository(this.store.getDatabase());
    const runner: typeof ProcessRunner.execute = (options) => ProcessRunner.execute({ ...options, repo });
    this.agy = config.agy ?? new AntigravityAdapter({ runner });
    this.manager = config.manager ?? new CodexManagerAdapter({ runner });
    this.managerPool = config.managerPool ?? ManagerProviderPool.fromEnvironment(this.store, this.manager);
    this.evidence = config.evidence ?? new EvidenceCollector({ execute: runner });
    this.productAdapter = config.productAdapter ?? new ProductTaskAutonomyAdapter({
      repo,
      autonomyStore: this.store,
      artifactStore: new ArtifactStore(path.join(runtimeRoot, 'artifacts')),
      evidenceCollector: this.evidence,
      maxWorkers: this.maxWorkers,
    });
    this.coderEndpoint = config.coderEndpoint !== undefined
      ? config.coderEndpoint
      : loadOmniRouteEndpointFromEnvironment('CODER');
    this.coderTransport = config.coderTransport ?? new ResponsesCoderEndpointTransport();
    if (this.coderEndpoint && !repo.getProviderResource(this.coderEndpoint.resource_id)) {
      const providerId = 'provider-external-router';
      if (!repo.getProvider(providerId)) {
        repo.createProvider({
          id: providerId,
          name: 'Configured external router',
          adapter_type: 'API',
          enabled: true,
          created_at: new Date().toISOString(),
        });
      }
      repo.createProviderResource({
        id: this.coderEndpoint.resource_id,
        provider_id: providerId,
        provider_account_id: null,
        model_name: this.coderEndpoint.model_or_route,
        health_status: this.coderEndpoint.health_state === 'DEGRADED'
          ? 'LOW_QUOTA'
          : this.coderEndpoint.health_state === 'CAPACITY_EXHAUSTED'
            ? 'QUOTA_EXHAUSTED'
            : this.coderEndpoint.health_state === 'CONTRACT_INVALID'
              ? 'UNHEALTHY'
              : this.coderEndpoint.health_state,
        capabilities: [...this.coderEndpoint.capabilities],
        enabled: this.coderEndpoint.enabled,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'ROUTE_REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: null,
      });
    }
    this.store.ensureSlots(this.maxWorkers);
  }

  private resolveAuthorizedCoder(auth: ExecutionAuthorization) {
    const row = this.store.getDatabase().prepare(`
      SELECT
        r.id AS resource_id,
        r.provider_id,
        r.provider_account_id,
        r.enabled AS resource_enabled,
        r.health_status AS resource_health,
        r.capabilities_json,
        p.adapter_type,
        p.enabled AS provider_enabled,
        a.enabled AS account_enabled,
        a.health_status AS account_health,
        a.cooldown_until AS account_cooldown_until
      FROM provider_resources r
      JOIN providers p ON p.id = r.provider_id
      LEFT JOIN provider_accounts a ON a.id = r.provider_account_id
      WHERE r.id = ?
    `).get(auth.selected_resource_id) as Record<string, unknown> | undefined;
    const binding: CoderResourceBinding | null = row ? {
      resourceId: String(row.resource_id),
      providerId: String(row.provider_id),
      providerAccountId: row.provider_account_id ? String(row.provider_account_id) : null,
      adapterType: row.adapter_type as CoderResourceBinding['adapterType'],
      providerEnabled: Boolean(row.provider_enabled),
      resourceEnabled: Boolean(row.resource_enabled),
      resourceHealth: String(row.resource_health),
      capabilities: row.capabilities_json ? JSON.parse(String(row.capabilities_json)) : [],
      accountEnabled: row.provider_account_id ? Boolean(row.account_enabled) : null,
      accountHealth: row.account_health ? String(row.account_health) : null,
      accountCooldownUntil: row.account_cooldown_until ? String(row.account_cooldown_until) : null,
    } : null;
    return resolveCoderProvider(auth, binding, this.coderEndpoint);
  }

  createWorkOrder(spec: AutonomousTaskSpec): WorkOrder {
    const order = createWorkOrder(spec);
    if (!path.isAbsolute(order.worktree)) throw new Error('CONTRACT_INVALID: worktree must be absolute');
    if (path.resolve(order.worktree).toLowerCase() === this.controlRepo.toLowerCase()) throw new Error('WORKTREE_IS_CONTROL_REPO: workers cannot run in the control repository');
    if (this.mode !== 'SHADOW') {
      if (!this.store.isProductTask(order.task_id)) {
        assertPathContained(order.worktree, this.worktreeRoot);
      }
      if (!AutonomySupervisor.isSafeWorktree(this.controlRepo, order.worktree)) throw new Error('UNSAFE_WORKTREE');
      if (!order.allowed_paths.length || !order.required_tests.length) throw new Error('CONTRACT_INVALID: allowed paths and deterministic tests are required');
      for (const entry of order.allowed_paths) assertPathContained(path.resolve(order.worktree, entry), order.worktree);
    }
    return order;
  }

  async run(spec: AutonomousTaskSpec): Promise<SupervisorRunResult> {
    if (this.store.isProductTask(spec.taskId)) {
      return this.runProductTask(spec);
    }
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
        let provider: ProviderRun;
        const db = this.store.getDatabase();
        const authRow = db.prepare(
          "SELECT * FROM execution_authorizations WHERE task_id = ? AND status IN ('AUTHORIZED','DISPATCHED') ORDER BY created_at DESC LIMIT 1"
        ).get(order.task_id) as ExecutionAuthorization | undefined;

        const selection = authRow ? this.resolveAuthorizedCoder(authRow) : resolveCoderProvider(authRow);
        if (selection.provider === 'NONE') {
          provider = {
            status: 'AUTH_ERROR',
            exitCode: 1,
            executionId: '',
            stdout: '',
            stderr: selection.error,
            durationMs: 0,
          };
        } else if (selection.provider === 'OMNIROUTE') {
          const endpoint = this.coderEndpoint ?? loadOmniRouteEndpointFromEnvironment('CODER');
          if (!endpoint) {
            provider = {
              status: 'AUTH_ERROR',
              exitCode: 1,
              executionId: '',
              stdout: '',
              stderr: 'OMNIROUTE_CODER_NOT_CONFIGURED: OmniRoute coder endpoint configuration missing',
              durationMs: 0,
            };
          } else {
            const executed = await this.coderTransport.executeWorkOrder(endpoint, order, authRow!.id);
            this.store.recordRun(row.id, 'omniroute-coder', executed.run);
            provider = executed.run;
            if (executed.run.status === 'SUCCESSFUL_PROCESS_EXIT' && executed.bundle) {
              try {
                const preEvidence = await this.evidence.collect(order, []);
                if (preEvidence.headSha !== executed.bundle.source_head.toLowerCase()) {
                  throw new Error(`STALE_SOURCE_HEAD: Worktree HEAD changed in flight: expected ${executed.bundle.source_head}, observed ${preEvidence.headSha}`);
                }
                applyCoderEditBundle(order.worktree, executed.bundle, {
                  taskId: order.task_id,
                  authorizationId: authRow!.id,
                  sourceHead: preEvidence.headSha,
                  allowedPaths: order.allowed_paths,
                  forbiddenPaths: order.forbidden_paths,
                });
              } catch (applyErr) {
                provider = {
                  status: 'CONTRACT_INVALID',
                  exitCode: 1,
                  executionId: executed.run.executionId,
                  stdout: executed.run.stdout,
                  stderr: applyErr instanceof Error ? applyErr.message : String(applyErr),
                  durationMs: executed.run.durationMs,
                };
              }
            }
          }
        } else if (selection.provider === 'AGY') {
          provider = await this.agy.execute(order);
          this.store.recordRun(row.id, 'antigravity', provider);
        } else {
          provider = {
            status: 'AUTH_ERROR',
            exitCode: 1,
            executionId: '',
            stdout: '',
            stderr: 'UNRECOGNIZED_CODER_PROVIDER',
            durationMs: 0,
          };
        }
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
        const reviewResult = await this.managerPool.review(buildManagerContextPackage({
          workOrder: order,
          currentHead: evidence.headSha,
          actualDiff: evidence.diff,
          changedFiles: evidence.changedFiles,
          deterministicTests: evidence.tests,
          previousManagerDecisions: this.store.getDatabase().prepare('SELECT payload_json FROM autonomy_reviews WHERE work_order_id=? ORDER BY created_at').all(row.id),
          repairHistory: this.store.getDatabase().prepare("SELECT payload_json FROM autonomy_events WHERE work_order_id=? AND event_type='REPAIR_REQUIRED' ORDER BY created_at").all(row.id),
          prState: this.store.getDatabase().prepare('SELECT * FROM autonomy_claims WHERE work_order_id=?').all(row.id),
          ciState: this.store.getDatabase().prepare('SELECT * FROM autonomy_ci_watches WHERE work_order_id=?').all(row.id),
          architecturePolicyContext: ['Supervisor owns leases, worktrees, GitHub, and verification.', 'PASS requires a fresh exact HEAD match.'],
        }));
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

  async runProductTask(spec: AutonomousTaskSpec): Promise<SupervisorRunResult> {
    const order = this.createWorkOrder(spec);
    if (this.mode === 'SHADOW') return { workOrder: order, state: 'READY', repairLoops: 0 };

    const db = this.store.getDatabase();
    const authRow = db.prepare(
      "SELECT * FROM execution_authorizations WHERE task_id = ? AND status IN ('AUTHORIZED','DISPATCHED') ORDER BY created_at DESC LIMIT 1"
    ).get(spec.taskId) as ExecutionAuthorization | undefined;

    if (!authRow) {
      return {
        workOrder: order,
        state: 'BLOCKED',
        repairLoops: 0,
        error: 'AUTHORIZATION_MISSING: PRODUCT_TASK_REQUIRES_EXECUTION_AUTHORIZATION: product tasks must have durable ExecutionAuthorization and cannot execute through legacy autonomy state',
      };
    }

    const selection = this.resolveAuthorizedCoder(authRow);
    if (selection.provider === 'NONE') {
      return {
        workOrder: order,
        state: 'BLOCKED',
        repairLoops: 0,
        error: selection.error,
      };
    }

    const executionResult = await this.productAdapter.executeProductTask({
      authorizationId: authRow.id,
      currentHeadSha: (await this.evidence.collect(order, [])).headSha,
      workerId: spec.workerId,
      branch: spec.branch,
      worktree: spec.worktree,
      allowedPaths: spec.allowedPaths ?? [],
      forbiddenPaths: spec.forbiddenPaths,
      dependencies: spec.dependencies,
      runCoder: async (wo) => {
        const selection = this.resolveAuthorizedCoder(authRow);
        if (selection.provider === 'NONE') {
          return {
            success: false,
            currentHeadSha: spec.baseSha,
            error: selection.error,
          };
        }

        if (selection.provider === 'OMNIROUTE') {
          const endpoint = this.coderEndpoint ?? loadOmniRouteEndpointFromEnvironment('CODER');
          if (!endpoint) {
            return {
              success: false,
              currentHeadSha: spec.baseSha,
              error: 'OMNIROUTE_CODER_NOT_CONFIGURED: OmniRoute coder endpoint configuration missing',
            };
          }
          const executed = await this.coderTransport.executeWorkOrder(endpoint, wo, authRow.id);
          // Product tasks do not own a legacy autonomy_work_orders row, so a
          // legacy autonomy_runs foreign-key write would fail here. Preserve
          // secret-safe provider evidence as an audit event instead.
          this.store.event(authRow.task_id, 'PRODUCT_CODER_PROVIDER_RUN', {
            provider: 'omniroute-coder',
            selectedProviderId: authRow.selected_provider_id,
            selectedResourceId: authRow.selected_resource_id,
            status: executed.run.status,
            exitCode: executed.run.exitCode,
            executionId: executed.run.executionId,
            durationMs: executed.run.durationMs,
          });
          if (executed.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !executed.bundle) {
            return {
              success: false,
              currentHeadSha: spec.baseSha,
              error: executed.run.error ?? executed.run.stderr ?? 'OMNIROUTE_CODER_FAILED',
            };
          }
          try {
            const preEvidence = await this.evidence.collect(wo, []);
            if (preEvidence.headSha !== executed.bundle.source_head.toLowerCase()) {
              return {
                success: false,
                currentHeadSha: preEvidence.headSha,
                error: `STALE_SOURCE_HEAD: Worktree HEAD changed in flight: expected ${executed.bundle.source_head}, observed ${preEvidence.headSha}`,
              };
            }
            applyCoderEditBundle(wo.worktree, executed.bundle, {
              taskId: wo.task_id,
              authorizationId: authRow.id,
              sourceHead: preEvidence.headSha,
              allowedPaths: wo.allowed_paths,
              forbiddenPaths: wo.forbidden_paths,
            });
          } catch (applyErr) {
            return {
              success: false,
              currentHeadSha: spec.baseSha,
              error: applyErr instanceof Error ? applyErr.message : String(applyErr),
            };
          }
          const ev = await this.evidence.collect(wo, []);
          return { success: true, currentHeadSha: ev.headSha };
        }

        if (selection.provider === 'AGY') {
          const provider = await this.agy.execute(wo);
          if (provider.status !== 'SUCCESSFUL_PROCESS_EXIT') {
            return { success: false, currentHeadSha: spec.baseSha, error: provider.error ?? provider.stderr };
          }
          const ev = await this.evidence.collect(wo, []);
          return { success: true, currentHeadSha: ev.headSha };
        }

        return {
          success: false,
          currentHeadSha: spec.baseSha,
          error: 'UNRECOGNIZED_CODER_PROVIDER',
        };
      },
      runVerification: async (authority, wo) => {
        const targetOrder = wo ?? order;
        const ev = await this.evidence.collect(targetOrder, targetOrder.required_tests);
        const passed = ev.tests.length === targetOrder.required_tests.length && ev.tests.length > 0 && ev.tests.every((t) => t.exitCode === 0);
        const firstTest = ev.tests[0];
        return this.productAdapter.recordVerificationObservation({
          projectId: authority.task.project_id,
          taskId: authority.task.id,
          attemptId: authority.authorization.attempt_id,
          command: targetOrder.required_tests.join(' && '),
          status: passed ? 'COMPLETED' : 'FAILED',
          exitCode: passed ? 0 : (firstTest?.exitCode ?? 1),
          passedCount: ev.tests.filter((t) => t.exitCode === 0).length,
          failedCount: ev.tests.filter((t) => t.exitCode !== 0).length,
          durationMs: ev.tests.reduce((acc, t) => acc + t.durationMs, 0),
          stdout: ev.tests.map((t) => t.stdout).join('\n'),
          stderr: ev.tests.map((t) => t.stderr).join('\n'),
          workingDirectory: targetOrder.worktree,
        });
      },
      conductReview: async (context) => {
        const reviewResult = await this.managerPool.review(context);
        if (!reviewResult.review) {
          throw new Error(reviewResult.run.error ?? reviewResult.run.stderr ?? 'MANAGER_REVIEW_FAILED');
        }
        return reviewResult.review;
      },
      evidenceCollector: this.evidence,
    });

    const isAccepted = executionResult.success;
    return {
      workOrder: executionResult.workOrder ?? order,
      state: (executionResult.finalTaskState as AutonomyState) || (isAccepted ? 'MANAGER_REVIEW' : 'FAILED'),
      accepted: isAccepted,
      review: executionResult.review,
      headSha: executionResult.observedHeadSha,
      repairLoops: 0,
      error: executionResult.error,
    };
  }

  getAvailableWorkerId(activeWorkerIds: Iterable<string> = []): string | null {
    const active = new Set(activeWorkerIds);
    for (const slot of this.store.listActiveSlots()) {
      if (slot.workerId) active.add(slot.workerId);
    }
    for (let i = 1; i <= this.maxWorkers; i++) {
      const candidate = `agy-${String(i).padStart(2, '0')}`;
      if (!active.has(candidate)) return candidate;
    }
    return null;
  }

  createContinuousQueue(options: Omit<SupervisorQueueOptions, 'supervisor'> = {}): SupervisorContinuousQueue {
    return new SupervisorContinuousQueue({ ...options, supervisor: this });
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

export interface SupervisorQueueTaskResult {
  accepted: boolean;
  state: AutonomyState;
  worktree?: string;
  branch?: string;
  error?: string;
  publishedHead?: string | null;
}

export interface SupervisorQueueCiObserver {
  observeDue: () => Promise<any[]>;
  publishAcceptedRepair?: (taskId: string, worktree: string, branch: string) => Promise<string | null>;
}

export interface SupervisorQueueOptions {
  supervisor: AutonomySupervisor;
  ci?: SupervisorQueueCiObserver;
  controlRepo?: string;
  worktreeRoot?: string;
  pollIntervalMs?: number;
  dispatchTask?: (task: SelfHostTask, workerId: string) => Promise<SupervisorQueueTaskResult>;
  onEvent?: (eventType: string, payload: any) => void;
}

export class SupervisorContinuousQueue {
  readonly supervisor: AutonomySupervisor;
  readonly store: AutonomyStore;
  readonly maxWorkers: number;
  readonly controlRepo: string;
  readonly worktreeRoot: string;
  readonly ci?: SupervisorQueueCiObserver;
  private readonly options: SupervisorQueueOptions;
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly activeWorkers = new Map<string, string>();

  constructor(options: SupervisorQueueOptions) {
    this.options = options;
    this.supervisor = options.supervisor;
    this.store = options.supervisor.store;
    this.maxWorkers = options.supervisor.maxWorkers;
    this.controlRepo = path.resolve(options.controlRepo ?? options.supervisor.controlRepo);
    this.worktreeRoot = path.resolve(options.worktreeRoot ?? options.supervisor.worktreeRoot);
    this.ci = options.ci;
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  getActiveTaskIds(): string[] {
    return Array.from(this.activeTasks.keys());
  }

  getActiveWorkerIds(): string[] {
    return Array.from(this.activeWorkers.values());
  }

  allocateWorkerIdentity(): string | null {
    if (this.activeTasks.size >= this.maxWorkers) return null;
    const inFlightWorkers = new Set(this.activeWorkers.values());
    for (let i = 1; i <= this.maxWorkers; i++) {
      const candidate = `agy-${String(i).padStart(2, '0')}`;
      if (!inFlightWorkers.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  async step(): Promise<{ dispatched: string | null; workerId: string | null; observations: any[] }> {
    let dispatched: string | null = null;
    let assignedWorker: string | null = null;

    if (!this.store.shouldStop() && this.activeTasks.size < this.maxWorkers) {
      const workerId = this.allocateWorkerIdentity();
      if (workerId) {
        const task = this.store.claimNext();
        if (task) {
          dispatched = task.task_id;
          assignedWorker = workerId;
          this.activeWorkers.set(task.task_id, workerId);

          const taskPromise = (async () => {
            try {
              const result = this.options.dispatchTask
                ? await this.options.dispatchTask(task, workerId)
                : await this.defaultDispatch(task, workerId);

              this.store.event(task.task_id, 'TASK_SETTLED', {
                accepted: result.accepted ?? false,
                state: result.state,
                worktree: result.worktree,
                branch: result.branch,
                error: result.error,
              });
              this.options.onEvent?.('TASK_SETTLED', {
                task: task.task_id,
                workerId,
                accepted: result.accepted ?? false,
                state: result.state,
                publishedHead: result.publishedHead ?? null,
              });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.store.event(task.task_id, 'TASK_BLOCKED', { error: errorMessage });
              this.options.onEvent?.('TASK_BLOCKED', { task: task.task_id, workerId, error: errorMessage });
            } finally {
              this.activeTasks.delete(task.task_id);
              this.activeWorkers.delete(task.task_id);
            }
          })();

          this.activeTasks.set(task.task_id, taskPromise);
        }
      }
    }

    let observations: any[] = [];
    if (this.ci) {
      try {
        observations = await this.ci.observeDue();
        for (const obs of observations) {
          this.options.onEvent?.('CI_OBSERVATION', obs);
        }
      } catch (error) {
        this.options.onEvent?.('CI_RETRY_DEFERRED', { error: String(error) });
      }
    }

    return { dispatched, workerId: assignedWorker, observations };
  }

  async waitForAllActive(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.all(Array.from(this.activeTasks.values()));
    }
  }

  async run(): Promise<number> {
    while (!this.store.shouldStop()) {
      const { dispatched } = await this.step();
      if (!dispatched && this.activeTasks.size === 0) {
        await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 1000));
      } else if (!dispatched) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.options.pollIntervalMs ?? 1000, 200)));
      }
    }
    await this.waitForAllActive();
    return 0;
  }

  private async defaultDispatch(task: SelfHostTask, workerId: string): Promise<SupervisorQueueTaskResult> {
    if (this.store.isProductTask(task.task_id)) {
      const db = this.store.getDatabase();
      const authRow = db.prepare(
        "SELECT * FROM execution_authorizations WHERE task_id = ? AND status IN ('AUTHORIZED','DISPATCHED') ORDER BY created_at DESC LIMIT 1"
      ).get(task.task_id) as ExecutionAuthorization | undefined;

      if (!authRow) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: 'PRODUCT_TASK_REQUIRES_EXECUTION_AUTHORIZATION: product tasks must have durable ExecutionAuthorization and cannot execute through legacy autonomy state',
        };
      }

      const productTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.task_id) as Task | undefined;
      if (!productTask) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: `TASK_NOT_FOUND: Task "${task.task_id}" was not found.`,
        };
      }

      // Validate the active durable ExecutionAuthorization before constructing any runtime specification
      const authorityValidation = this.supervisor.productAdapter.validateAuthority({
        authorizationId: authRow.id,
        currentHeadSha: authRow.repository_head_sha,
      });

      if (!authorityValidation.valid || !authorityValidation.authority) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: `${authorityValidation.code}: ${authorityValidation.error}`,
        };
      }

      const { task: validatedTask, authorization, assignment } = authorityValidation.authority;
      if (!authorization.canonical_payload_json) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: 'CANONICAL_PAYLOAD_MISSING: ExecutionAuthorization has no canonical payload.',
        };
      }

      let canonicalPayload: CanonicalExecutionPayload;
      try {
        canonicalPayload = CanonicalExecutionPayloadSchema.parse(JSON.parse(authorization.canonical_payload_json));
      } catch (error) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: `CANONICAL_PAYLOAD_INVALID: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (!canonicalPayload.executionScope) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: 'EXECUTION_SCOPE_MISSING: ExecutionAuthorization canonical payload is missing required executionScope.',
        };
      }

      const authorizedScope = canonicalPayload.executionScope;
      if (!path.isAbsolute(authorizedScope.worktree) && !path.win32.isAbsolute(authorizedScope.worktree) && !path.posix.isAbsolute(authorizedScope.worktree)) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: 'WORKTREE_MUST_BE_ABSOLUTE: Authorized executionScope worktree must be an absolute path.',
        };
      }

      if (!authorizedScope.allowedPaths || authorizedScope.allowedPaths.length === 0) {
        return {
          accepted: false,
          state: 'BLOCKED',
          error: 'ALLOWED_PATHS_REQUIRED: Authorized executionScope allowedPaths must contain at least one path.',
        };
      }

      const attempt = assignment.attempt_id
        ? (db.prepare('SELECT attempt_number FROM task_attempts WHERE id = ?').get(assignment.attempt_id) as { attempt_number: number } | undefined)
        : null;

      const requiredTests = Object.values(canonicalPayload.verificationCommands)
        .filter((command): command is { executable: string; args: string[] } => command !== null)
        .map(renderCommand);

      const spec: AutonomousTaskSpec = {
        taskId: validatedTask.id,
        issueNumber: null,
        workerId,
        objective: validatedTask.description ?? validatedTask.title,
        baseSha: authorization.base_sha,
        branch: authorizedScope.branch,
        worktree: authorizedScope.worktree,
        dependencies: (task as { dependencies?: string[] }).dependencies ?? [],
        allowedPaths: [...authorizedScope.allowedPaths],
        forbiddenPaths: [...authorizedScope.forbiddenPaths],
        acceptanceCriteria: [...canonicalPayload.acceptanceCriteria],
        requiredTests: requiredTests.length > 0 ? requiredTests : task.required_tests,
        contextFiles: [...canonicalPayload.contextFiles],
        constraints: [...canonicalPayload.constraints, ...canonicalPayload.instructions],
        attempt: attempt?.attempt_number ?? validatedTask.revision_count + 1,
        leaseEpoch: validatedTask.ownership_epoch ?? 1,
      };

      const runResult = await this.supervisor.runProductTask(spec);
      return {
        accepted: runResult.accepted ?? false,
        state: runResult.state,
        worktree: spec.worktree,
        branch: spec.branch,
        error: runResult.error,
      };
    }

    fs.mkdirSync(this.worktreeRoot, { recursive: true });
    const gitExec = (process.env.Path ?? process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git')).find((file) => fs.existsSync(file)) || (process.platform === 'win32' ? 'git.exe' : 'git');
    const id = crypto.randomUUID().slice(0, 8);
    const branch = `agent/${workerId}/${task.task_id.toLowerCase()}-${id}`;
    const worktrees = new GitWorktreeService({ gitExecutable: gitExec, repositoryRoot: this.controlRepo, managedRoot: this.worktreeRoot });
    const head = spawnSync(gitExec, ['rev-parse', '--verify', task.base_sha ?? 'HEAD'], { cwd: this.controlRepo, encoding: 'utf8', windowsHide: true, shell: false });
    const headSha = String(head.stdout ?? '').trim();
    if (head.status !== 0 || !/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new Error(`SELF_HOST_BASE_SHA_FAILED: ${head.stderr || head.stdout}`);
    }
    const tuple = { projectId: 'AGENT-FORGE', taskId: task.task_id, assignmentId: id, workerSlotId: workerId, baseSha: headSha };
    this.supervisor.store.event(tuple.taskId, 'WORKTREE_INTENT', tuple);
    const added = await worktrees.createWorktree(tuple);
    if (added.status !== 'CREATED') throw new Error(`SELF_HOST_WORKTREE_CREATE_FAILED: ${added.error}`);
    const worktree = added.worktreePath;
    this.supervisor.store.event(tuple.taskId, 'WORKTREE_CREATED', { worktree, branch, baseSha: headSha });
    const branchResult = spawnSync(gitExec, ['switch', '-c', branch], { cwd: worktree, encoding: 'utf8', windowsHide: true, shell: false });
    if (branchResult.status !== 0) throw new Error(`SELF_HOST_BRANCH_CREATE_FAILED: ${String(branchResult.stderr || branchResult.stdout).trim()}`);

    const seed: AutonomousTaskSpec = {
      taskId: task.task_id,
      issueNumber: null,
      workerId,
      objective: task.objective,
      baseSha: headSha,
      branch,
      worktree,
      allowedPaths: task.allowed_paths,
      forbiddenPaths: ['.git', this.controlRepo, 'main'],
      acceptanceCriteria: task.acceptance_criteria,
      requiredTests: task.required_tests,
      contextFiles: task.context_files ?? [],
      constraints: ['Do not push or merge.', 'Do not modify files outside the allowed path.', ...(task.constraints ?? [])],
    };

    const authorized = this.supervisor.store.getDatabase().prepare("SELECT id FROM autonomy_events WHERE work_order_id=? AND event_type='TASK_MANAGER_AUTHORIZED'").get(task.task_id);
    const planned = authorized ? {
      workOrder: createWorkOrder(seed),
      run: { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: '', stdout: '', stderr: '', durationMs: 0, error: undefined },
      resource_id: 'authorized',
      attempts: [],
    } : await this.supervisor.managerPool.plan({
      task_id: seed.taskId, worker_id: seed.workerId, objective: seed.objective,
      base_sha: seed.baseSha, branch: seed.branch, worktree: seed.worktree,
      acceptance_criteria: seed.acceptanceCriteria,
      required_tests: seed.requiredTests,
      allowed_paths: seed.allowedPaths,
      forbidden_paths: seed.forbiddenPaths,
      constraints: seed.constraints,
    });
    this.supervisor.store.event(seed.taskId, 'MANAGER_PLAN', planned);
    if (!planned.workOrder) throw new Error(`SELF_HOST_MANAGER_PLAN_FAILED: ${planned.run.error || planned.run.stderr}`);

    const runResult = await this.supervisor.run({
      taskId: planned.workOrder.task_id,
      issueNumber: planned.workOrder.issue_number,
      workerId: planned.workOrder.worker_id,
      objective: planned.workOrder.objective,
      baseSha: planned.workOrder.base_sha,
      branch: planned.workOrder.branch,
      worktree: planned.workOrder.worktree,
      dependencies: planned.workOrder.dependencies,
      allowedPaths: planned.workOrder.allowed_paths,
      forbiddenPaths: planned.workOrder.forbidden_paths,
      acceptanceCriteria: planned.workOrder.acceptance_criteria,
      requiredTests: planned.workOrder.required_tests,
      contextFiles: planned.workOrder.context_files,
      constraints: planned.workOrder.constraints,
      attempt: planned.workOrder.attempt,
      leaseEpoch: planned.workOrder.lease_epoch,
    });

    let publishedHead: string | null = null;
    if (runResult.accepted && this.ci?.publishAcceptedRepair) {
      publishedHead = await this.ci.publishAcceptedRepair(task.task_id, worktree, branch);
    }
    return {
      accepted: runResult.accepted ?? false,
      state: runResult.state,
      worktree,
      branch,
      error: runResult.error,
      publishedHead,
    };
  }
}
