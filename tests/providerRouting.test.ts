import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { CodexCliAdapter } from '../src/core/adapters/CodexCliAdapter';
import {
  ProviderRoutingService,
  RoutingRequest,
  RoutingDecision,
} from '../src/core/services/ProviderRoutingService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import {
  ProviderAdapter,
  QuotaSnapshotInfo,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../src/core/adapters/ProviderAdapter';
import {
  Capability,
  ProviderHealthStatus,
  ProviderAdapterType,
  QuotaSource,
} from '../src/core/types/domain';

/**
 * Controllable mock adapter for deterministic routing and dispatch test cases.
 */
class MockProviderAdapter implements ProviderAdapter {
  public executionCount = 0;
  public cancelCount = 0;
  public probeError?: Error;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    public health: ProviderHealthStatus = 'AVAILABLE',
    public capabilities: Capability[] = ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
    public quota: QuotaSnapshotInfo = {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN',
      confidence: 0.0,
      resetAt: null,
    },
    public customExecutionResult?: Partial<AgentExecutionResult>
  ) {}

  public async getCapabilities(): Promise<Capability[]> {
    if (this.probeError) throw this.probeError;
    return this.capabilities;
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    if (this.probeError) throw this.probeError;
    return this.health;
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    if (this.probeError) throw this.probeError;
    return this.quota;
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.executionCount++;
    if (this.customExecutionResult) {
      return {
        executionId: crypto.randomUUID(),
        status: this.customExecutionResult.status ?? 'COMPLETED',
        outputProtocol: this.customExecutionResult.outputProtocol,
        rawResponse: this.customExecutionResult.rawResponse,
        error: this.customExecutionResult.error,
        stdoutEvidenceId: this.customExecutionResult.stdoutEvidenceId,
        stderrEvidenceId: this.customExecutionResult.stderrEvidenceId,
      };
    }
    return {
      executionId: crypto.randomUUID(),
      status: 'COMPLETED',
      outputProtocol: JSON.stringify({
        protocol: 'coder.v1',
        message_id: 'msg-mock-001',
        project_id: request.projectId,
        task_id: request.taskId,
        attempt: 1,
        status: 'COMPLETED',
        completed: ['Mock work completed'],
        remaining: [],
        files_claimed_changed: [],
        tests_claimed: [],
        blockers: [],
        review_requested: true,
        expected_task_state: 'CODING',
        expected_revision: 0,
      }),
      rawResponse: 'Mock execution raw response',
    };
  }

  public async cancel(_executionId: string): Promise<void> {
    this.cancelCount++;
  }
}

describe('PR #6 — Deterministic Quota-Aware Provider Routing & Pre-Dispatch Failover', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let registry: ProviderRegistry;
  let router: ProviderRoutingService;
  let dispatcher: ProviderDispatchService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-route-test-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    registry = new ProviderRegistry();
    router = new ProviderRoutingService(repo, registry, eventService);
    dispatcher = new ProviderDispatchService(registry);

    // Create base project and task
    repo.createProject({
      id: 'PROJ-ROUTING',
      name: 'Routing Test Project',
      description: 'Testing quota-aware provider routing',
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    repo.createTask({
      id: 'TSK-ROUTING-001',
      project_id: 'PROJ-ROUTING',
      milestone_id: null,
      title: 'Provider Routing Task',
      description: 'Validate pre-dispatch failover',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: '0000000000000000000000000000000000000000',
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Routing succeeds'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper to register mock provider & provider resource
  function setupResource(
    resourceId: string,
    providerId: string,
    options: {
      health?: ProviderHealthStatus;
      capabilities?: Capability[];
      enabled?: boolean;
      quotaRemaining?: number | null;
      quotaTotal?: number | null;
      quotaUnit?: string;
      quotaSource?: QuotaSource;
      adapterType?: ProviderAdapterType;
      mockAdapter?: MockProviderAdapter;
      customExecutionResult?: Partial<AgentExecutionResult>;
    } = {}
  ): MockProviderAdapter {
    const now = new Date().toISOString();
    const adapterType = options.adapterType ?? 'LOCAL_CLI';

    if (!repo.getProvider(providerId)) {
      repo.createProvider({
        id: providerId,
        name: `Provider ${providerId}`,
        adapter_type: adapterType,
        enabled: true,
        created_at: now,
      });
    }

    const caps = options.capabilities ?? ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'];
    repo.createProviderResource({
      id: resourceId,
      provider_id: providerId,
      model_name: `Model for ${resourceId}`,
      health_status: options.health ?? 'AVAILABLE',
      capabilities: caps,
      enabled: options.enabled ?? true,
      total_quota: options.quotaTotal ?? null,
      remaining_quota: options.quotaRemaining ?? null,
      quota_unit: options.quotaUnit ?? 'REQUESTS',
      quota_reset_at: null,
      quota_source: options.quotaSource ?? 'UNKNOWN',
      quota_confidence: 0.0,
      last_health_check: now,
    });

    let adapter = options.mockAdapter;
    if (!adapter) {
      adapter = new MockProviderAdapter(
        providerId,
        `Adapter ${providerId}`,
        adapterType,
        options.health ?? 'AVAILABLE',
        caps,
        {
          remaining: options.quotaRemaining ?? null,
          total: options.quotaTotal ?? null,
          unit: options.quotaUnit ?? 'REQUESTS',
          source: options.quotaSource ?? 'UNKNOWN',
          confidence: 0.0,
          resetAt: null,
        },
        options.customExecutionResult
      );
    }

    if (!registry.has(providerId)) {
      registry.register(adapter);
    }
    return adapter;
  }

  // 1. Same inputs/snapshots → same RoutingDecision
  it('1. Same inputs and snapshots produce identical deterministic RoutingDecision', async () => {
    setupResource('res-a', 'prov-a', { health: 'AVAILABLE' });
    setupResource('res-b', 'prov-b', { health: 'LOW_QUOTA' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-a', 'res-b'],
      allowManualBridge: false,
    };

    const decision1 = await router.route(req);
    const decision2 = await router.route(req);

    expect(decision1.outcome).toBe('SELECTED');
    expect(decision1.selectedResourceId).toBe('res-a');
    expect(decision1.selectedProviderId).toBe('prov-a');
    expect(decision2.outcome).toBe(decision1.outcome);
    expect(decision2.selectedResourceId).toBe(decision1.selectedResourceId);
    expect(decision2.candidateEvaluations.length).toBe(decision1.candidateEvaluations.length);
  });

  // 2. Empty candidate list → NO_ELIGIBLE_PROVIDER
  it('2. Empty candidate list returns NO_ELIGIBLE_PROVIDER', async () => {
    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: [],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.selectedResourceId).toBeNull();
    expect(decision.reason).toContain('No candidate resources provided');
  });

  // 3. Duplicate candidates rejected
  it('3. Duplicate candidate IDs in request are rejected explicitly', async () => {
    setupResource('res-a', 'prov-a');

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-a', 'res-a'],
      allowManualBridge: false,
    };

    await expect(router.route(req)).rejects.toThrow(/Duplicate candidate resource ID/);
  });

  // 4. Unknown resource explicitly rejected/ineligible
  it('4. Unknown resource ID is marked ineligible with explicit rejection reason', async () => {
    setupResource('res-valid', 'prov-valid');

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-nonexistent', 'res-valid'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-valid');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('not found in database');
  });

  // 5. Missing adapter explicitly rejected/ineligible
  it('5. Resource with unregistered adapter is marked ineligible', async () => {
    // Create resource in DB without registering adapter in registry
    repo.createProvider({
      id: 'prov-unregistered',
      name: 'Unregistered Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    repo.createProviderResource({
      id: 'res-unregistered',
      provider_id: 'prov-unregistered',
      model_name: 'Unregistered Model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-unregistered'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('not registered in ProviderRegistry');
  });

  // 6. Disabled resource never selected
  it('6. Disabled resource is never selected even if health is AVAILABLE', async () => {
    setupResource('res-disabled', 'prov-dis', { enabled: false, health: 'AVAILABLE' });
    setupResource('res-enabled', 'prov-en', { enabled: true, health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-disabled', 'res-enabled'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-enabled');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('disabled');
  });

  // 7. Capability mismatch never selected
  it('7. Candidate lacking required capabilities is marked ineligible', async () => {
    setupResource('res-coder', 'prov-coder', { capabilities: ['CODING'] });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING', 'SECURITY_REVIEW'], // Missing SECURITY_REVIEW
      candidateResourceIds: ['res-coder'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('Required capabilities');
  });

  // 8. AVAILABLE automated resource selected
  it('8. AVAILABLE automated resource matching capabilities is selected', async () => {
    setupResource('res-avail', 'prov-avail', { health: 'AVAILABLE', capabilities: ['CODING'] });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-avail'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-avail');
    expect(decision.adapterType).toBe('LOCAL_CLI');
  });

  // 9. LOW_QUOTA is eligible
  it('9. LOW_QUOTA resource is eligible when no AVAILABLE candidate exists', async () => {
    setupResource('res-low', 'prov-low', { health: 'LOW_QUOTA', capabilities: ['CODING'] });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-low'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-low');
    expect(decision.reason).toContain('LOW_QUOTA');
  });

  // 10. AVAILABLE outranks LOW_QUOTA even when LOW_QUOTA appears first
  it('10. AVAILABLE outranks LOW_QUOTA regardless of candidate list ordering', async () => {
    setupResource('res-low', 'prov-low', { health: 'LOW_QUOTA' });
    setupResource('res-avail', 'prov-avail', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-low', 'res-avail'], // LOW_QUOTA first
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-avail');
  });

  // 11. Same-tier ordering preserves candidateResourceIds order
  it('11. Within same eligibility tier, candidate input ordering is preserved', async () => {
    setupResource('res-avail-1', 'prov-avail-1', { health: 'AVAILABLE' });
    setupResource('res-avail-2', 'prov-avail-2', { health: 'AVAILABLE' });

    const req1: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-avail-1', 'res-avail-2'],
      allowManualBridge: false,
    };
    const decision1 = await router.route(req1);
    expect(decision1.selectedResourceId).toBe('res-avail-1');

    const req2: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-avail-2', 'res-avail-1'],
      allowManualBridge: false,
    };
    const decision2 = await router.route(req2);
    expect(decision2.selectedResourceId).toBe('res-avail-2');
  });

  // 12. health QUOTA_EXHAUSTED blocks candidate
  it('12. Health QUOTA_EXHAUSTED blocks candidate from automated selection', async () => {
    setupResource('res-exhausted', 'prov-ex', { health: 'QUOTA_EXHAUSTED' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-exhausted'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('QUOTA_EXHAUSTED');
  });

  // 13. Authoritative remaining=0 blocks candidate
  it('13. Authoritative quota remaining=0 (MEASURED/PROVIDER_REPORTED/MANUAL) blocks candidate', async () => {
    setupResource('res-zero', 'prov-zero', {
      health: 'AVAILABLE',
      quotaRemaining: 0,
      quotaSource: 'PROVIDER_REPORTED',
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-zero'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('Authoritative quota exhausted');
  });

  // 14. Authoritative remaining<0 blocks candidate
  it('14. Authoritative quota remaining < 0 blocks candidate', async () => {
    setupResource('res-neg', 'prov-neg', {
      health: 'AVAILABLE',
      quotaRemaining: -5,
      quotaSource: 'MEASURED',
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-neg'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('Authoritative quota exhausted');
  });

  // 15. UNKNOWN quota + AVAILABLE health remains eligible
  it('15. UNKNOWN quota with AVAILABLE health remains eligible without invented numbers', async () => {
    setupResource('res-unknown-q', 'prov-uq', {
      health: 'AVAILABLE',
      quotaRemaining: null,
      quotaSource: 'UNKNOWN',
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-unknown-q'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-unknown-q');
    expect(decision.candidateEvaluations[0].quotaSnapshot.source).toBe('UNKNOWN');
  });

  // 16. ESTIMATED remaining=0 does not by itself hard-block
  it('16. ESTIMATED quota with remaining=0 does not hard-block candidate when health is AVAILABLE', async () => {
    setupResource('res-est-zero', 'prov-ez', {
      health: 'AVAILABLE',
      quotaRemaining: 0,
      quotaSource: 'ESTIMATED',
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-est-zero'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-est-zero');
  });

  // 17. Quota values with different units are never numerically ranked
  it('17. Quota values with different units are not cross-ranked numerically', async () => {
    setupResource('res-tokens', 'prov-tok', {
      health: 'AVAILABLE',
      quotaRemaining: 500,
      quotaUnit: 'TOKENS',
      quotaSource: 'MEASURED',
    });
    setupResource('res-requests', 'prov-req', {
      health: 'AVAILABLE',
      quotaRemaining: 10,
      quotaUnit: 'REQUESTS',
      quotaSource: 'MEASURED',
    });

    // When both are AVAILABLE, first in candidateResourceIds order wins
    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-requests', 'res-tokens'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-requests');
  });

  // 18. RATE_LIMITED candidate skipped before dispatch
  it('18. RATE_LIMITED candidate is skipped during pre-dispatch evaluation', async () => {
    setupResource('res-rate-limited', 'prov-rl', { health: 'RATE_LIMITED' });
    setupResource('res-avail', 'prov-av', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-rate-limited', 'res-avail'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-avail');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
  });

  // 19. OFFLINE candidate skipped before dispatch
  it('19. OFFLINE candidate is skipped during pre-dispatch evaluation', async () => {
    setupResource('res-offline', 'prov-off', { health: 'OFFLINE' });
    setupResource('res-avail', 'prov-av', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-offline', 'res-avail'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-avail');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
  });

  // 20. AUTH_ERROR → NEEDS_OWNER and DOES NOT fail over
  it('20. AUTH_ERROR halts routing immediately, returns NEEDS_OWNER, and does NOT fail over', async () => {
    setupResource('res-auth-err', 'prov-ae', { health: 'AUTH_ERROR' });
    setupResource('res-avail', 'prov-av', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-auth-err', 'res-avail'], // AUTH_ERROR first
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NEEDS_OWNER');
    expect(decision.selectedResourceId).toBeNull();
    expect(decision.reason).toContain('AUTH_ERROR');
    // Second candidate must not be evaluated
    expect(decision.candidateEvaluations.length).toBe(1);
  });

  // 21. Codex current OFFLINE resource cannot route
  it('21. Real CodexCliAdapter resource cannot route and is marked OFFLINE', async () => {
    const codexAdapter = new CodexCliAdapter();
    registry.register(codexAdapter);
    repo.createProvider({
      id: 'prov-codex-cli',
      name: 'Codex CLI',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    repo.createProviderResource({
      id: 'res-codex',
      provider_id: 'prov-codex-cli',
      model_name: 'Codex CLI',
      health_status: 'UNKNOWN',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-codex'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].health).toBe('OFFLINE');
  });

  // 22. Manual Bridge not selected when allowManualBridge=false
  it('22. Manual Bridge is not selected when allowManualBridge=false', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);
    repo.createProvider({
      id: 'prov-manual-bridge',
      name: 'Owner Manual Bridge',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    repo.createProviderResource({
      id: 'res-manual',
      provider_id: 'prov-manual-bridge',
      model_name: 'Manual Bridge Coder',
      health_status: 'UNKNOWN',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-manual'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain('allowManualBridge=false');
  });

  // 23. Manual Bridge explicitly permitted → MANUAL_HANDOFF_REQUIRED
  it('23. Manual Bridge explicitly permitted yields MANUAL_HANDOFF_REQUIRED', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);
    repo.createProvider({
      id: 'prov-manual-bridge',
      name: 'Owner Manual Bridge',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    repo.createProviderResource({
      id: 'res-manual-permitted',
      provider_id: 'prov-manual-bridge',
      model_name: 'Manual Bridge Coder',
      health_status: 'UNKNOWN',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-manual-permitted'],
      allowManualBridge: true,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');
    expect(decision.selectedResourceId).toBe('res-manual-permitted');
    expect(decision.selectedProviderId).toBe('prov-manual-bridge');
  });

  // 24. No implicit Manual Bridge fallback
  it('24. No implicit Manual Bridge fallback when automated candidates fail and Manual Bridge is not in candidates', async () => {
    setupResource('res-failing', 'prov-fail', { health: 'OFFLINE' });
    // Manual bridge exists in registry but NOT in candidateResourceIds
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-failing'],
      allowManualBridge: true,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.selectedResourceId).toBeNull();
  });

  // 25. Routing phase executes zero providers
  it('25. Routing phase evaluates candidates without executing any provider processes', async () => {
    const mock1 = setupResource('res-1', 'prov-1', { health: 'AVAILABLE' });
    const mock2 = setupResource('res-2', 'prov-2', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-1', 'res-2'],
      allowManualBridge: false,
    };

    await router.route(req);
    expect(mock1.executionCount).toBe(0);
    expect(mock2.executionCount).toBe(0);
  });

  // 26. Dispatch executes selected automated provider exactly once
  it('26. Dispatch executes the selected automated provider exactly once', async () => {
    const mock = setupResource('res-exec', 'prov-exec', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-exec'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('SELECTED');

    const result = await dispatcher.dispatch(decision, {
      taskId: 'TSK-ROUTING-001',
      projectId: 'PROJ-ROUTING',
      instructions: ['Do work'],
      contextFiles: [],
    });

    expect(mock.executionCount).toBe(1);
    expect(result.status).toBe('COMPLETED');
  });

  // 27. Manual handoff executes ManualBridge exactly once and returns AWAITING_OWNER
  it('27. Dispatch for MANUAL_HANDOFF_REQUIRED executes Manual Bridge and returns AWAITING_OWNER', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);
    repo.createProvider({
      id: 'prov-manual-bridge',
      name: 'Manual Bridge',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    repo.createProviderResource({
      id: 'res-manual-handoff',
      provider_id: 'prov-manual-bridge',
      model_name: 'Manual Model',
      health_status: 'UNKNOWN',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-manual-handoff'],
      allowManualBridge: true,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');

    const result = await dispatcher.dispatch(decision, {
      taskId: 'TSK-ROUTING-001',
      projectId: 'PROJ-ROUTING',
      instructions: ['Manual task'],
      contextFiles: [],
    });

    expect(result.status).toBe('AWAITING_OWNER');
  });

  // 28. Automated provider execution FAILED → second provider execution count remains 0
  it('28. Post-dispatch execution FAILED does NOT trigger automatic failover to second candidate', async () => {
    const failingMock = setupResource('res-primary', 'prov-primary', {
      health: 'AVAILABLE',
      customExecutionResult: { status: 'FAILED', error: 'Process crashed with segmentation fault' },
    });
    const secondaryMock = setupResource('res-secondary', 'prov-secondary', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-primary', 'res-secondary'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.selectedResourceId).toBe('res-primary');

    const result = await dispatcher.dispatch(decision, {
      taskId: 'TSK-ROUTING-001',
      projectId: 'PROJ-ROUTING',
      instructions: ['Run task'],
      contextFiles: [],
    });

    expect(result.status).toBe('FAILED');
    expect(failingMock.executionCount).toBe(1);
    expect(secondaryMock.executionCount).toBe(0); // ZERO post-dispatch failover
  });

  // 29. PROTOCOL_INVALID → second provider execution count remains 0
  it('29. Post-dispatch PROTOCOL_INVALID does not trigger automatic retry or failover', async () => {
    const invalidProtoMock = setupResource('res-proto-invalid', 'prov-pi', {
      health: 'AVAILABLE',
      customExecutionResult: {
        status: 'FAILED',
        error: 'PROTOCOL_INVALID: Output did not contain coder.v1',
      },
    });
    const backupMock = setupResource('res-backup-29', 'prov-b29', { health: 'AVAILABLE' });

    const decision: RoutingDecision = {
      decisionId: 'dec-29',
      outcome: 'SELECTED',
      selectedResourceId: 'res-proto-invalid',
      selectedProviderId: 'prov-pi',
      adapterType: 'LOCAL_CLI',
      candidateEvaluations: [],
      reason: 'Selected primary',
      createdAt: new Date().toISOString(),
    };

    const result = await dispatcher.dispatch(decision, {
      taskId: 'TSK-ROUTING-001',
      projectId: 'PROJ-ROUTING',
      instructions: ['Task'],
      contextFiles: [],
    });

    expect(result.status).toBe('FAILED');
    expect(invalidProtoMock.executionCount).toBe(1);
    expect(backupMock.executionCount).toBe(0);
  });

  // 30. Timeout-after-start → second provider execution count remains 0
  it('30. Post-dispatch timeout does not trigger automatic failover', async () => {
    const timeoutMock = setupResource('res-timeout', 'prov-to', {
      health: 'AVAILABLE',
      customExecutionResult: { status: 'FAILED', error: 'Process timed out after 30000ms' },
    });
    const backupMock = setupResource('res-backup-30', 'prov-b30', { health: 'AVAILABLE' });

    const decision: RoutingDecision = {
      decisionId: 'dec-30',
      outcome: 'SELECTED',
      selectedResourceId: 'res-timeout',
      selectedProviderId: 'prov-to',
      adapterType: 'LOCAL_CLI',
      candidateEvaluations: [],
      reason: 'Selected primary',
      createdAt: new Date().toISOString(),
    };

    const result = await dispatcher.dispatch(decision, {
      taskId: 'TSK-ROUTING-001',
      projectId: 'PROJ-ROUTING',
      instructions: ['Task'],
      contextFiles: [],
    });

    expect(result.status).toBe('FAILED');
    expect(timeoutMock.executionCount).toBe(1);
    expect(backupMock.executionCount).toBe(0);
  });

  // 31. Policy denial → second provider execution count remains 0
  it('31. Policy denial does not trigger automatic failover', async () => {
    const policyMock = setupResource('res-policy-denied', 'prov-pd', {
      health: 'AVAILABLE',
      customExecutionResult: {
        status: 'FAILED',
        error: 'Context file violates security policy: sensitive path',
      },
    });
    const backupMock = setupResource('res-backup-31', 'prov-b31', { health: 'AVAILABLE' });

    const decision: RoutingDecision = {
      decisionId: 'dec-31',
      outcome: 'SELECTED',
      selectedResourceId: 'res-policy-denied',
      selectedProviderId: 'prov-pd',
      adapterType: 'LOCAL_CLI',
      candidateEvaluations: [],
      reason: 'Selected primary',
      createdAt: new Date().toISOString(),
    };

    const result = await dispatcher.dispatch(decision, {
      taskId: 'TSK-ROUTING-001',
      projectId: 'PROJ-ROUTING',
      instructions: ['Task'],
      contextFiles: [],
    });

    expect(result.status).toBe('FAILED');
    expect(policyMock.executionCount).toBe(1);
    expect(backupMock.executionCount).toBe(0);
  });

  // 32. Cancellation → second provider execution count remains 0
  it('32. Execution cancellation does not trigger failover to another provider', async () => {
    const cancelMock = setupResource('res-cancelled', 'prov-canc', {
      health: 'AVAILABLE',
      customExecutionResult: { status: 'CANCELLED', error: 'Execution was cancelled.' },
    });
    const backupMock = setupResource('res-backup-32', 'prov-b32', { health: 'AVAILABLE' });

    const decision: RoutingDecision = {
      decisionId: 'dec-32',
      outcome: 'SELECTED',
      selectedResourceId: 'res-cancelled',
      selectedProviderId: 'prov-canc',
      adapterType: 'LOCAL_CLI',
      candidateEvaluations: [],
      reason: 'Selected primary',
      createdAt: new Date().toISOString(),
    };

    const result = await dispatcher.dispatch(decision, {
      taskId: 'TSK-ROUTING-001',
      projectId: 'PROJ-ROUTING',
      instructions: ['Task'],
      contextFiles: [],
    });

    expect(result.status).toBe('CANCELLED');
    expect(cancelMock.executionCount).toBe(1);
    expect(backupMock.executionCount).toBe(0);
  });

  // 33. Routing decision event persisted
  it('33. Routing decision creates durable PROVIDER_ROUTING_DECISION event in SQLite', async () => {
    setupResource('res-event-test', 'prov-et', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-event-test'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    const events = eventService.getEvents('PROJ-ROUTING');
    const routingEvent = events.find((e) => e.type === 'PROVIDER_ROUTING_DECISION');

    expect(routingEvent).toBeDefined();
    expect(routingEvent!.project_id).toBe('PROJ-ROUTING');
    expect(routingEvent!.task_id).toBe('TSK-ROUTING-001');
    expect(routingEvent!.structured_payload.decisionId).toBe(decision.decisionId);
    expect(routingEvent!.structured_payload.outcome).toBe('SELECTED');
  });

  // 34. Routing event contains health/quota decision evidence
  it('34. Persisted routing event contains health and quota telemetry evidence for each candidate', async () => {
    setupResource('res-ev-health', 'prov-eh', {
      health: 'AVAILABLE',
      quotaRemaining: 150,
      quotaTotal: 500,
      quotaSource: 'MEASURED',
    });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-ev-health'],
      allowManualBridge: false,
    };

    await router.route(req);
    const events = eventService.getEvents('PROJ-ROUTING');
    const routingEvent = events.find((e) => e.type === 'PROVIDER_ROUTING_DECISION')!;

    const payload = routingEvent.structured_payload as any;
    expect(payload.candidateEvaluations[0].health).toBe('AVAILABLE');
    expect(payload.candidateEvaluations[0].quotaSnapshot.remaining).toBe(150);
    expect(payload.candidateEvaluations[0].quotaSnapshot.source).toBe('MEASURED');
  });

  // 35. Routing event contains no prompt/instructions/secrets
  it('35. Persisted routing event contains no task instructions, prompt text, or environment secrets', async () => {
    setupResource('res-ev-safe', 'prov-safe', { health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-ev-safe'],
      allowManualBridge: false,
    };

    await router.route(req);
    const events = eventService.getEvents('PROJ-ROUTING');
    const routingEvent = events.find((e) => e.type === 'PROVIDER_ROUTING_DECISION')!;

    const rawStr = JSON.stringify(routingEvent);
    expect(rawStr).not.toContain('instructions');
    expect(rawStr).not.toContain('prompt');
    expect(rawStr).not.toContain('apiKey');
    expect(rawStr).not.toContain('SECRET');
  });

  // 36. Task state unchanged by route-only operation
  it('36. Task state in SQLite remains unchanged after pure routing evaluation', async () => {
    setupResource('res-state-check', 'prov-sc', { health: 'AVAILABLE' });
    const initialTask = repo.getTask('TSK-ROUTING-001')!;
    expect(initialTask.state).toBe('CODING');

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-state-check'],
      allowManualBridge: false,
    };

    await router.route(req);

    const taskAfter = repo.getTask('TSK-ROUTING-001')!;
    expect(taskAfter.state).toBe('CODING');
    expect(taskAfter.updated_at).toBe(initialTask.updated_at);
  });

  // 37. Provider/resource enabled state never mutated by router
  it('37. Provider and ProviderResource enabled flags in database are never mutated by router', async () => {
    setupResource('res-disabled-mut', 'prov-dm', { enabled: false, health: 'AVAILABLE' });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-disabled-mut'],
      allowManualBridge: false,
    };

    await router.route(req);

    const resRecord = repo.getProviderResource('res-disabled-mut')!;
    expect(resRecord.enabled).toBe(false); // Still false, no silent mutation
  });

  // 38. Telemetry probe exception recorded truthfully
  it('38. Telemetry probe exception is recorded truthfully as an evaluation error', async () => {
    const errorAdapter = new MockProviderAdapter('prov-err', 'Error Adapter');
    errorAdapter.probeError = new Error('Socket timeout connecting to local CLI probe');
    setupResource('res-probe-err', 'prov-err', { mockAdapter: errorAdapter });

    const req: RoutingRequest = {
      projectId: 'PROJ-ROUTING',
      taskId: 'TSK-ROUTING-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-probe-err'],
      allowManualBridge: false,
    };

    const decision = await router.route(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain(
      'Health probe threw exception: Socket timeout'
    );
  });

  // 39. Restart can read persisted routing decision event
  it('39. Restart can read persisted routing decision events from database', async () => {
    const bootstrapDir = path.join(tmpDir, 'restart-routing-db');
    fs.mkdirSync(path.join(bootstrapDir, 'database'), { recursive: true });
    const dbPath = path.join(bootstrapDir, 'database', 'agent-forge.db');

    const db1 = new Database(dbPath);
    MigrationRunner.run(db1);
    const repo1 = new Repository(db1);
    const eventService1 = new EventService(repo1);
    const registry1 = new ProviderRegistry();

    const mock = new MockProviderAdapter('prov-restart', 'Restart Adapter');
    registry1.register(mock);

    repo1.createProject({
      id: 'PROJ-REST',
      name: 'Restart Project',
      description: 'Test',
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    repo1.createProvider({
      id: 'prov-restart',
      name: 'Restart Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    repo1.createProviderResource({
      id: 'res-restart',
      provider_id: 'prov-restart',
      model_name: 'Restart Model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    repo1.createTask({
      id: 'TSK-REST',
      project_id: 'PROJ-REST',
      milestone_id: null,
      title: 'Restart Task',
      description: 'Testing restart event survival',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: '0000000000000000000000000000000000000000',
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const router1 = new ProviderRoutingService(repo1, registry1, eventService1);
    const decision = await router1.route({
      projectId: 'PROJ-REST',
      taskId: 'TSK-REST',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-restart'],
      allowManualBridge: false,
    });
    expect(decision.outcome).toBe('SELECTED');
    db1.close();

    // Reopen database
    const db2 = new Database(dbPath);
    const repo2 = new Repository(db2);
    const eventService2 = new EventService(repo2);

    const reloadedEvents = eventService2.getEvents('PROJ-REST');
    expect(reloadedEvents.length).toBeGreaterThan(0);
    const persistedEvent = reloadedEvents.find((e) => e.type === 'PROVIDER_ROUTING_DECISION');
    expect(persistedEvent).toBeDefined();
    expect(persistedEvent!.structured_payload.decisionId).toBe(decision.decisionId);
    expect(persistedEvent!.structured_payload.selectedResourceId).toBe('res-restart');
    db2.close();
  });

  // 40. No API keys required
  it('40. Provider routing functions entirely offline without any external network or API keys', async () => {
    // Execute routing in isolated environment with no env variables
    const originalEnv = process.env;
    process.env = {};

    try {
      setupResource('res-offline-clean', 'prov-oc', { health: 'AVAILABLE' });

      const req: RoutingRequest = {
        projectId: 'PROJ-ROUTING',
        taskId: 'TSK-ROUTING-001',
        requiredCapabilities: ['CODING'],
        candidateResourceIds: ['res-offline-clean'],
        allowManualBridge: false,
      };

      const decision = await router.route(req);
      expect(decision.outcome).toBe('SELECTED');
      expect(decision.selectedResourceId).toBe('res-offline-clean');
    } finally {
      process.env = originalEnv;
    }
  });
});
