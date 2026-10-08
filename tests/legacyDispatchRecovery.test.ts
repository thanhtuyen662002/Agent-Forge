import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { EventService } from '../src/core/services/EventService';
import type { AgentExecutionResult, ProviderAdapter } from '../src/core/adapters/ProviderAdapter';
import { ProviderRoutingService } from '../src/core/services/ProviderRoutingService';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ExecutionRecoveryScanner } from '../src/core/services/ExecutionRecoveryScanner';
import { NonHandoffExecutionLifecycle } from '../src/core/services/NonHandoffExecutionLifecycle';
import { GitService } from '../src/core/services/GitService';
import { canonicalJsonStringify, computeSha256 } from '../src/core/context/ContextIntegrity';
import { ProjectStopFenceService } from '../src/core/services/ProjectStopFenceService';
import { VerificationCapabilityService } from '../src/core/services/VerificationCapabilityService';
import { approveFixtureCommand } from './helpers/verificationCapabilityFixture';
import { LocalCliAdapterBase } from '../src/core/adapters/LocalCliAdapterBase';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { ArtifactStore } from '../src/core/services/ArtifactStore';

class RecoveryFixtureCli extends LocalCliAdapterBase {
  readonly id = 'provider';
  readonly name = 'Recovery fixture CLI';
  constructor(private readonly script: string, repo: Repository, artifactStore: ArtifactStore) {
    super({ executable: process.execPath, repo, artifactStore, timeoutMs: 5000 });
  }
  protected getDefaultExecutable(): string { return process.execPath; }
  protected buildExecutionArgs(): string[] { return [this.script]; }
  async getCapabilities() { return ['CODING' as const]; }
}

describe('complete compatibility dispatch / recovery boundary', () => {
  let root: string;
  let db: Database.Database;
  let repo: Repository;
  let registry: ProviderRegistry;
  let execute: ReturnType<typeof vi.fn<ProviderAdapter['execute']>>;
  let cancel: ReturnType<typeof vi.fn<ProviderAdapter['cancel']>>;
  let adapter: ProviderAdapter;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(GitService, 'getHeadSha').mockResolvedValue({ status: 'SUCCESS', sha: 'a'.repeat(40) });
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-legacy-dispatch-')));
    db = new Database(path.join(root, 'state.sqlite'));
    db.pragma('foreign_keys=ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    registry = new ProviderRegistry();
    execute = vi.fn<ProviderAdapter['execute']>(async () => ({ executionId: 'untrusted-provider-id', status: 'COMPLETED' }));
    cancel = vi.fn<ProviderAdapter['cancel']>(async () => {});
    adapter = { id: 'provider', name: 'Fixture provider', adapterType: 'MOCK', execute, cancel,
      getHealth: async () => 'AVAILABLE', getCapabilities: async () => ['CODING'],
      getQuota: async () => ({ remaining: null, total: null, unit: 'REQUESTS', source: 'UNKNOWN', confidence: 0, resetAt: null }) };
    const now = new Date().toISOString();
    repo.createProject({ id: 'P', name: 'Dispatch fixture', description: null, repository_path: root, default_branch: 'main',
      status: 'RUNNING', contract: null, created_at: now, updated_at: now, started_at: now, completed_at: null });
    repo.createTask({ id: 'T', project_id: 'P', milestone_id: null, title: 'Legacy execution', description: null,
      state: 'CODING', paused_from_state: null, priority: 'HIGH', risk: 'LOW', assigned_agent_id: null, revision_count: 0,
      max_revisions: 3, base_sha: 'a'.repeat(40), current_sha: 'a'.repeat(40), progress_cache_percent: 0,
      progress_computed_at: null, acceptance_criteria: [], constraints: [], created_at: now, updated_at: now });
    const manager = JSON.stringify({ protocol: 'manager.v1', message_id: 'manager', project_id: 'P', task_id: 'T',
      decision: 'EXECUTE', priority: 'HIGH', risk: 'LOW', expected_revision: 0, expected_task_state: null,
      instructions: ['Fixture instruction'], acceptance_criteria: [], constraints: [], review_issues: [] });
    repo.recordProtocolMessage('manager', 'manager', 'manager.v1', 'P', 'T', null, 0, computeSha256(manager), manager, 'APPLIED');
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-legacy-dispatch-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function authorize(manual = false, contextFiles: string[] = []) {
    if (manual) adapter.adapterType = 'MANUAL_BRIDGE';
    const now = new Date().toISOString();
    repo.createProvider({ id: adapter.id, name: adapter.name, adapter_type: adapter.adapterType, enabled: true, created_at: now });
    repo.createProviderResource({ id: 'resource', provider_id: adapter.id, model_name: 'fixture', health_status: 'AVAILABLE',
      capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS',
      quota_reset_at: null, quota_source: 'UNKNOWN', quota_confidence: 0, last_health_check: null });
    registry.register(adapter);
    const routing = await new ProviderRoutingService(repo, registry, new EventService(repo)).route({ projectId: 'P', taskId: 'T',
      requiredCapabilities: ['CODING'], candidateResourceIds: ['resource'], allowManualBridge: manual });
    const auth = await new ExecutionAuthorizationService(repo).createAuthorization({ projectId: 'P', taskId: 'T',
      routingDecisionId: routing.decisionId, contextFiles, ...(manual ? { executionMode: 'MANUAL_BRIDGE' as const } : {}) });
    return repo.getExecutionAuthorization(auth.id)!;
  }
  function dispatcher(timeout = 5000) { return new ProviderDispatchService(registry, repo, undefined, undefined, { nonHandoffTimeoutMs: timeout }); }
  function reopen() {
    db.close();
    db = new Database(path.join(root, 'state.sqlite'));
    db.pragma('foreign_keys=ON');
    repo = new Repository(db);
    return new ExecutionRecoveryScanner(db, repo);
  }

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)('persists actual %s with the backend execution identity and replays without task success', async status => {
    execute.mockResolvedValue({ executionId: 'provider-supplied-id', status, errorCode: status === 'FAILED' ? 'EXECUTION_FAILED' : null });
    const auth = await authorize();
    const result = await dispatcher().dispatch(auth.id);
    expect(result.status, result.error).toBe(status);
    const durable = repo.getExecutionAuthorization(auth.id)!;
    expect(durable).toMatchObject({ execution_id: result.executionId, settlement_status: status, adapter_outcome: status === 'CANCELLED' ? 'CANCELLED' : 'RETURNED' });
    expect(result.executionId).not.toBe('provider-supplied-id');
    expect(durable.adapter_started_at).toBeTruthy();
    expect(durable.adapter_finished_at).toBeTruthy();
    const scanner = reopen();
    expect(scanner.scanAndReconcile().items).toContainEqual(expect.objectContaining({ authorizationId: auth.id,
      classification: 'ALREADY_RECONCILED', mutatedResources: false }));
    const events = repo.getEvents('P', 100);
    scanner.scanAndReconcile();
    expect(repo.getEvents('P', 100)).toEqual(events);
    expect(repo.getTask('T')?.state).toBe('CODING');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('preserves a thrown provider failure durably without retry or task success', async () => {
    execute.mockRejectedValue(new Error('Fixture provider failure'));
    const auth = await authorize();
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED', errorCode: 'EXECUTION_FAILED' });
    expect(repo.getExecutionAuthorization(auth.id)).toMatchObject({ settlement_status: 'FAILED', adapter_outcome: 'THREW' });
    expect(reopen().scanAndReconcile().items[0].classification).toBe('ALREADY_RECONCILED');
    expect(repo.getTask('T')?.state).toBe('CODING');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records explicit owner relay as AWAITING_OWNER without a completed settlement', async () => {
    execute.mockResolvedValue({ executionId: 'manual-id', status: 'AWAITING_OWNER' });
    const auth = await authorize(true);
    expect(await dispatcher().dispatchManualBridge(auth.id)).toMatchObject({ status: 'AWAITING_OWNER' });
    expect(repo.getExecutionAuthorization(auth.id)).toMatchObject({ adapter_outcome: 'RETURNED', settlement_status: null, settled_at: null });
    expect(reopen().scanAndReconcile().items[0].classification).toBe('ALREADY_RECONCILED');
    expect(repo.getTask('T')?.state).toBe('CODING');
  });

  it('preserves an actual pending provider return without promoting routing or settling the task', async () => {
    execute.mockResolvedValue({ executionId: 'provider-pending', status: 'AWAITING_OWNER' });
    const auth = await authorize();
    const routing = repo.getEvents('P', 100).find(event => event.type === 'PROVIDER_ROUTING_DECISION');
    expect(routing!.structured_payload).toMatchObject({ outcome: 'SELECTED' });
    const result = await dispatcher().dispatch(auth.id);
    expect(result).toMatchObject({ status: 'AWAITING_OWNER', providerExecutionProvenance: { adapterInvocation: 'RETURNED' } });
    expect(repo.getExecutionAuthorization(auth.id)).toMatchObject({ status: 'DISPATCHED', execution_id: result.executionId,
      adapter_outcome: 'RETURNED', settlement_status: null, settled_at: null });
    expect(reopen().scanAndReconcile().items[0]).toMatchObject({ classification: 'ALREADY_RECONCILED',
      mutatedTerminalState: false, mutatedResources: false });
    expect(repo.getEvents('P', 100).find(event => event.id === routing!.id)).toEqual(routing);
    expect(repo.getTask('T')?.state).toBe('CODING');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('binds a real Local CLI child process to the durable backend execution identity', async () => {
    const script = path.join(root, 'fixture-cli.cjs');
    const protocol = { protocol: 'coder.v1', message_id: 'fixture-child', project_id: 'P', task_id: 'T', attempt: 1,
      status: 'COMPLETED', completed: ['Fixture child exited'], remaining: [], files_claimed_changed: [], tests_claimed: [],
      blockers: [], review_requested: false, expected_task_state: 'CODING', expected_revision: 0 };
    fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write(${JSON.stringify(JSON.stringify(protocol))}); });`, 'utf8');
    adapter = new RecoveryFixtureCli(script, repo, new ArtifactStore(path.join(root, 'artifacts')));
    const auth = await authorize();
    const result = await dispatcher().dispatch(auth.id);
    expect(result.status, result.error).toBe('COMPLETED');
    const rows = repo.getProcessRunsByTask('T');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.executionId, exit_code: 0, status: 'COMPLETED' });
    expect(repo.getExecutionAuthorization(auth.id)?.execution_id).toBe(rows[0].id);
    expect(reopen().scanAndReconcile().items[0].classification).toBe('ALREADY_RECONCILED');
  });

  it('passes the backend identity to the actual Manual Bridge adapter without inventing assignment authority', async () => {
    adapter = new ManualBridgeAdapter();
    const called = vi.spyOn(adapter, 'execute');
    const auth = await authorize(true);
    const result = await dispatcher().dispatchManualBridge(auth.id);
    expect(result.status, result.error).toBe('AWAITING_OWNER');
    expect(await called.mock.results[0].value).toMatchObject({ executionId: result.executionId });
    expect(called.mock.calls[0][0].runtimeBinding).toBeUndefined();
    expect(repo.getExecutionAuthorization(auth.id)?.execution_id).toBe(result.executionId);
    expect(reopen().scanAndReconcile().items[0].classification).toBe('ALREADY_RECONCILED');
  });

  it('cancels the same real child identity on timeout while keeping authorization termination unresolved', async () => {
    const script = path.join(root, 'fixture-hung-cli.cjs');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);', 'utf8');
    adapter = new RecoveryFixtureCli(script, repo, new ArtifactStore(path.join(root, 'artifacts')));
    const called = vi.spyOn(adapter, 'execute');
    const auth = await authorize();
    const result = await dispatcher(150).dispatch(auth.id);
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT' });
    const actual = await called.mock.results[0].value;
    expect(actual).toMatchObject({ executionId: result.executionId, status: 'CANCELLED' });
    expect(repo.getProcessRunsByTask('T')[0]).toMatchObject({ id: result.executionId, status: 'CANCELLED' });
    expect(repo.getExecutionAuthorization(auth.id)).toMatchObject({ termination_status: 'UNRESOLVED', settled_at: null });
    expect(reopen().scanAndReconcile().items[0].classification).toBe('ADAPTER_IN_FLIGHT_UNRESOLVED');
  }, 15000);

  it('retains actual child exit evidence without copying stale provider changes into a newer owner epoch', async () => {
    fs.mkdirSync(path.join(root, 'src'));
    const source = path.join(root, 'src', 'allowed.ts');
    const original = 'export const keep = true;\n';
    fs.writeFileSync(source, original, 'utf8');
    const script = path.join(root, 'fixture-stale-cli.cjs');
    const protocol = { protocol: 'coder.v1', message_id: 'fixture-stale-child', project_id: 'P', task_id: 'T', attempt: 1,
      status: 'COMPLETED', completed: ['Fixture child exited'], remaining: [], files_claimed_changed: ['src/allowed.ts'],
      tests_claimed: [], blockers: [], review_requested: false, expected_task_state: 'CODING', expected_revision: 0 };
    fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => {
      require('fs').appendFileSync('src/allowed.ts', '// stale provider write\\n');
      process.stdout.write(${JSON.stringify(JSON.stringify(protocol))}); });`, 'utf8');
    adapter = new RecoveryFixtureCli(script, repo, new ArtifactStore(path.join(root, 'artifacts')));
    const run = adapter.execute.bind(adapter);
    const called = vi.spyOn(adapter, 'execute').mockImplementation(request => {
      const actual = run(request);
      expect(repo.bumpTaskOwnershipEpoch('T', 1).success).toBe(true);
      return actual;
    });
    const auth = await authorize(false, ['src/allowed.ts']);
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED', errorCode: 'SETTLEMENT_FAILED' });
    expect(await called.mock.results[0].value).toMatchObject({ status: 'FAILED', errorCode: 'RECOVERY_FENCED',
      rawResponse: JSON.stringify(protocol) });
    expect(repo.getProcessRunsByTask('T')[0]).toMatchObject({ status: 'COMPLETED', exit_code: 0 });
    expect(fs.readFileSync(source, 'utf8')).toBe(original);
    expect(repo.getExecutionAuthorization(auth.id)?.settled_at).toBeNull();
    expect(reopen().scanAndReconcile().items[0].classification).toBe('AUTHORITY_CONFLICT');
  });

  it('discovers a crash after the atomic claim receipt and safely expires only a positively unstarted execution', async () => {
    const auth = await authorize();
    const lifecycle = new NonHandoffExecutionLifecycle(repo);
    const captured = lifecycle.capture(auth, 'backend-claimed', 5000);
    expect(lifecycle.claim(auth, captured, new Date().toISOString())).toBe(true);
    const scanner = reopen();
    expect(scanner.scanAndReconcile().items[0]).toMatchObject({ classification: 'PRE_ADAPTER_NOT_STARTED', mutatedTerminalState: true, mutatedResources: false });
    expect(repo.getExecutionAuthorization(auth.id)?.status).toBe('INVALIDATED');
    const events = repo.getEvents('P', 100);
    expect(scanner.scanAndReconcile().items[0].mutatedTerminalState).toBe(false);
    expect(repo.getEvents('P', 100)).toEqual(events);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fences an uncertain crash after adapter start without releasing or completing work', async () => {
    const auth = await authorize();
    const lifecycle = new NonHandoffExecutionLifecycle(repo);
    const captured = lifecycle.capture(auth, 'backend-started', 5000);
    expect(lifecycle.claim(auth, captured, new Date().toISOString())).toBe(true);
    expect(lifecycle.start(auth, captured)).toBe(true);
    expect(reopen().scanAndReconcile().items[0]).toMatchObject({ classification: 'ADAPTER_IN_FLIGHT_UNRESOLVED', disposition: 'UNRESOLVED_FENCED', mutatedResources: false });
    expect(repo.getExecutionAuthorization(auth.id)?.settled_at).toBeNull();
  });

  it('bounds a hung provider and cancellation, fences timeout after restart and ignores late completion', async () => {
    let finish!: (value: AgentExecutionResult) => void;
    execute.mockImplementation(() => new Promise<AgentExecutionResult>(resolve => { finish = resolve; }));
    cancel.mockImplementation(() => new Promise(() => {}));
    const auth = await authorize();
    const dispatch = dispatcher(25);
    const result = await dispatch.dispatch(auth.id);
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT', providerExecutionProvenance: { adapterInvocation: 'TIMED_OUT' } });
    expect(repo.getExecutionAuthorization(auth.id)).toMatchObject({ adapter_outcome: 'TIMED_OUT', adapter_finished_at: null,
      termination_status: 'UNRESOLVED', termination_confirmed_at: null, settled_at: null });
    expect(cancel).toHaveBeenCalledWith(result.executionId);
    finish({ executionId: 'late-provider-id', status: 'COMPLETED' });
    await Promise.resolve();
    const scanner = reopen();
    expect(scanner.scanAndReconcile().items[0]).toMatchObject({ classification: 'ADAPTER_IN_FLIGHT_UNRESOLVED', mutatedResources: false });
    expect(repo.getExecutionAuthorization(auth.id)?.settled_at).toBeNull();
    expect(repo.getTask('T')?.state).toBe('CODING');
  });

  it('rejects a newer task epoch during the first Git await before claiming or invoking the provider', async () => {
    const auth = await authorize();
    vi.mocked(GitService.getHeadSha).mockImplementation(async () => {
      repo.bumpTaskOwnershipEpoch('T', 1);
      return { status: 'SUCCESS', sha: 'a'.repeat(40) };
    });
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED' });
    expect(repo.getExecutionAuthorization(auth.id)?.status).toBe('AUTHORIZED');
    expect(repo.getTaskOwnershipEpoch('T')).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('retains the actual provider observation while a newer epoch fences settlement', async () => {
    const auth = await authorize();
    execute.mockImplementation(async () => {
      repo.bumpTaskOwnershipEpoch('T', 1);
      return { executionId: 'provider-id', status: 'COMPLETED' };
    });
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED', errorCode: 'SETTLEMENT_FAILED' });
    expect(repo.getEvents('P', 100).find(event => event.type === 'NON_HANDOFF_EXECUTION_RESULT')?.structured_payload)
      .toMatchObject({ evidence: { status: 'COMPLETED' } });
    expect(reopen().scanAndReconcile().items[0]).toMatchObject({ classification: 'AUTHORITY_CONFLICT', mutatedResources: false });
    expect(repo.getTaskOwnershipEpoch('T')).toBe(2);
    expect(repo.getExecutionAuthorization(auth.id)?.settled_at).toBeNull();
  });

  it('preserves the emergency stop CAS inside an atomic compatibility claim', async () => {
    const auth = await authorize();
    const dispatch = dispatcher();
    const original = repo.claimExecutionAuthorization.bind(repo);
    vi.spyOn(repo, 'claimExecutionAuthorization').mockImplementation((id, at) => {
      new ProjectStopFenceService(repo).requestStopForAllProjects('Fixture stop', undefined, undefined, ['P']);
      return original(id, at);
    });
    expect(await dispatch.dispatch(auth.id)).toMatchObject({ status: 'FAILED' });
    expect(execute).not.toHaveBeenCalled();
    expect(repo.getEvents('P', 100).filter(event => event.type === 'NON_HANDOFF_EXECUTION_CLAIMED')).toHaveLength(0);
  });

  it('keeps capability withdrawal during provider execution from producing a successful settlement', async () => {
    const command = await approveFixtureCommand(repo, 'P', ['--version']);
    repo.setProjectVerificationCommands('P', { TEST: command });
    const auth = await authorize();
    execute.mockImplementation(async () => {
      new VerificationCapabilityService(repo).revoke(command.capability);
      return { executionId: 'provider-id', status: 'COMPLETED' };
    });
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED', errorCode: 'SETTLEMENT_FAILED' });
    expect(repo.getExecutionAuthorization(auth.id)?.settled_at).toBeNull();
    expect(repo.getEvents('P', 100).find(event => event.type === 'NON_HANDOFF_EXECUTION_RESULT')?.structured_payload)
      .toMatchObject({ evidence: { status: 'COMPLETED' } });
  });

  it('keeps an emergency stop and resume during provider execution from settling an old admission', async () => {
    const auth = await authorize();
    execute.mockImplementation(async () => {
      const fence = new ProjectStopFenceService(repo);
      fence.requestStopForAllProjects('Fixture stop', undefined, undefined, ['P']);
      fence.resumeProject('P');
      return { executionId: 'provider-id', status: 'COMPLETED' };
    });
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED', errorCode: 'SETTLEMENT_FAILED' });
    expect(repo.getExecutionAuthorization(auth.id)?.settled_at).toBeNull();
    expect(repo.getEvents('P', 100).find(event => event.type === 'NON_HANDOFF_EXECUTION_RESULT')?.structured_payload)
      .toMatchObject({ evidence: { status: 'COMPLETED' } });
  });

  it.each([null, {}, { status: 'SUCCESS' }, { status: 'COMPLETED', outputProtocol: { forged: true } }])
    ('persists malformed provider returns as protocol failure rather than success or a timeout', async returned => {
      const auth = await authorize();
      execute.mockResolvedValue(returned as unknown as AgentExecutionResult);
      expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED', errorCode: 'PROTOCOL_INVALID',
        providerExecutionProvenance: { adapterInvocation: 'RETURNED' } });
      expect(repo.getExecutionAuthorization(auth.id)).toMatchObject({ settlement_status: 'FAILED', adapter_outcome: 'RETURNED' });
      expect(reopen().scanAndReconcile().items[0].classification).toBe('ALREADY_RECONCILED');
      expect(repo.getTask('T')?.state).toBe('CODING');
    });

  it('persists a provider rejection without an Error value as a thrown failure', async () => {
    const auth = await authorize();
    execute.mockRejectedValue(null);
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'FAILED', errorCode: 'EXECUTION_FAILED',
      providerExecutionProvenance: { adapterInvocation: 'THREW' } });
    expect(repo.getExecutionAuthorization(auth.id)).toMatchObject({ settlement_status: 'FAILED', adapter_outcome: 'THREW' });
    expect(reopen().scanAndReconcile().items[0].classification).toBe('ALREADY_RECONCILED');
  });

  it('rejects altered settlement authority even if its hash is recomputed', async () => {
    const auth = await authorize();
    expect(await dispatcher().dispatch(auth.id)).toMatchObject({ status: 'COMPLETED' });
    const durable = repo.getExecutionAuthorization(auth.id)!;
    const altered = JSON.parse(durable.settlement_evidence_json!);
    altered.routing_decision_id = 'forged-route';
    const json = canonicalJsonStringify(altered);
    db.prepare('UPDATE execution_authorizations SET settlement_evidence_json = ?, settlement_evidence_hash = ? WHERE id = ?')
      .run(json, computeSha256(json), auth.id);
    expect(reopen().scanAndReconcile().items[0]).toMatchObject({ classification: 'ADAPTER_FINISHED_RESULT_MISSING',
      disposition: 'RESULT_MISSING_FENCED', mutatedResources: false });
    expect(repo.getTask('T')?.state).toBe('CODING');
  });
});
