import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { GitWorktreeService } from '../src/core/services/GitWorktreeService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import {
  ProviderAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
} from '../src/core/adapters/ProviderAdapter';
import {
  ProviderAdapterType,
  ProviderHealthStatus,
  Capability,
  ExecutionAuthorization,
  AgentAssignment,
  ProviderAccount,
  ProviderResource,
  RoleProfile,
  AgentProfile,
  ProviderHealthObservation,
} from '../src/core/types/domain';
import {
  ProviderDispatchService,
  ProviderDispatchExecutionResult,
  ProviderExecutionProvenanceV1,
} from '../src/core/services/ProviderDispatchService';
import { ProviderHealthObservationService } from '../src/core/services/ProviderHealthObservationService';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';

class MockAdapter implements ProviderAdapter {
  public executeResult?: Partial<AgentExecutionResult> & Record<string, any>;
  public throwError?: Error;
  public executeCallCount = 0;
  public lastRequest?: AgentExecutionRequest;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    public health: ProviderHealthStatus = 'AVAILABLE',
    public capabilities: Capability[] = ['CODING', 'FILESYSTEM_EDIT']
  ) {}

  public async getCapabilities(): Promise<Capability[]> {
    return this.capabilities;
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    return this.health;
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN',
      confidence: 0.0,
      resetAt: null,
    };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.executeCallCount++;
    this.lastRequest = request;

    if (this.throwError) {
      throw this.throwError;
    }

    const assignedId = request.runtimeBinding?.executionId ?? crypto.randomUUID();
    return {
      executionId: assignedId,
      status: 'COMPLETED',
      outputProtocol: JSON.stringify({
        protocol: 'coder.v1',
        message_id: 'msg-rec-exec',
        project_id: request.projectId,
        task_id: request.taskId,
        attempt: 1,
        status: 'COMPLETED',
        completed: ['Task finished'],
        remaining: [],
        files_claimed_changed: [],
        tests_claimed: [],
      }),
      rawResponse: 'Mock response',
      ...(this.executeResult ?? {}),
    };
  }

  public async cancel(_executionId: string): Promise<void> {}
}

function createHierarchy(repo: Repository, repoDir: string, baseSha: string, customAuthId?: string) {
  const now = new Date().toISOString();
  const projectId = 'proj-obs-1';
  const taskId = 'task-obs-1';
  const attemptId = 'att-obs-1';
  const slotId = 'slot-obs-1';
  const providerId = 'prov-test-obs';
  const accountId = 'acc-obs-1';
  const resourceId = 'res-obs-1';
  const roleProfileId = 'role-obs-1';
  const agentProfileId = 'prof-obs-1';
  const assignmentId = 'assign-obs-1';
  const authId = customAuthId ?? 'auth-obs-1';
  const routingDecisionId = 'rd-obs-1';

  repo.createProject({
    id: projectId,
    name: 'Obs Project',
    description: null,
    contract: null,
    repository_path: repoDir,
    default_branch: 'main',
    status: 'RUNNING',
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  });

  repo.createTask({
    id: taskId,
    project_id: projectId,
    milestone_id: null,
    title: 'Obs Task',
    description: 'Obs Task Description',
    state: 'CODING',
    paused_from_state: null,
    priority: 'HIGH',
    risk: 'LOW',
    assigned_agent_id: null,
    revision_count: 1,
    max_revisions: 3,
    base_sha: baseSha,
    current_sha: baseSha,
    progress_cache_percent: 0,
    progress_computed_at: null,
    constraints: [],
    acceptance_criteria: ['must pass tests'],
    created_at: now,
    updated_at: now,
  });

  repo.createTaskAttempt({
    id: attemptId,
    task_id: taskId,
    agent_id: 'agent-obs-1',
    attempt_number: 1,
    status: 'RUNNING',
    started_at: now,
    ended_at: null,
    summary: null,
  });

  repo.createProvider({
    id: providerId,
    name: 'Obs Provider',
    adapter_type: 'LOCAL_CLI',
    enabled: true,
    created_at: now,
  });

  const account: ProviderAccount = {
    id: accountId,
    provider_id: providerId,
    label: 'Obs Account',
    auth_mode: 'NATIVE_PROFILE',
    credential_ref: null,
    profile_ref: 'native-profile://gemini/g01',
    enabled: true,
    priority: 1,
    health_status: 'AVAILABLE',
    cooldown_until: null,
    concurrency_limit: 2,
    last_success_at: null,
    last_failure_at: null,
    last_failure_code: null,
    created_at: now,
    updated_at: now,
  };
  repo.createProviderAccount(account);

  const resource: ProviderResource = {
    id: resourceId,
    provider_id: providerId,
    provider_account_id: accountId,
    model_name: 'gemini-1.5-pro',
    capabilities: ['CODING', 'FILESYSTEM_EDIT'],
    enabled: true,
    health_status: 'AVAILABLE',
    total_quota: 100,
    remaining_quota: 100,
    quota_unit: 'requests',
    quota_reset_at: null,
    quota_source: 'ESTIMATED',
    quota_confidence: 1.0,
    last_health_check: now,
  };
  repo.createProviderResource(resource);

  repo.createWorkerSlot({
    id: slotId,
    provider_account_id: accountId,
    provider_resource_id: resourceId,
    slot_index: 0,
    status: 'IDLE',
    current_assignment_id: null,
    current_execution_id: null,
    heartbeat_at: null,
    created_at: now,
    updated_at: now,
  });

  const role: RoleProfile = {
    id: roleProfileId,
    role: 'CODER',
    display_name: 'Coder Role',
    required_capabilities: ['CODING'],
    preferred_capabilities: [],
    authority_scope: null,
    permissions: ['read', 'write'],
    output_protocol: 'coder.v1',
    enabled: true,
    created_at: now,
    updated_at: now,
  };
  repo.createRoleProfile(role);

  const profile: AgentProfile = {
    id: agentProfileId,
    role_profile_id: roleProfileId,
    name: 'Coder Profile',
    prompt_template: 'System Prompt',
    config: {},
    enabled: true,
    created_at: now,
    updated_at: now,
  };
  repo.createAgentProfile(profile);

  const assignment: AgentAssignment = {
    id: assignmentId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    role_profile_id: roleProfileId,
    agent_profile_id: agentProfileId,
    selected_provider_id: providerId,
    selected_account_id: accountId,
    selected_resource_id: resourceId,
    selected_worker_slot_id: slotId,
    routing_decision_id: routingDecisionId,
    preferred_metadata: null,
    status: 'ASSIGNED',
    created_at: now,
    ended_at: null,
  };
  repo.createAgentAssignment(assignment);

  const managerMessageId = 'msg-obs-1';
  const managerPayload = JSON.stringify({
    protocol: 'manager.v1',
    message_id: managerMessageId,
    project_id: projectId,
    task_id: taskId,
    decision: 'EXECUTE',
    instructions: ['Implement feature'],
    constraints: [],
    suggested_approaches: [],
  });
  const managerPayloadHash = crypto.createHash('sha256').update(managerPayload).digest('hex');

  repo.recordProtocolMessage(
    managerMessageId,
    managerMessageId,
    'manager.v1',
    projectId,
    taskId,
    'CODING',
    1,
    managerPayloadHash,
    managerPayload,
    'APPLIED',
    undefined,
    now
  );

  new EventService(repo).record(
    projectId,
    'PROVIDER_ROUTING_DECISION',
    'Routing decision SELECTED',
    {
      decisionId: routingDecisionId,
      projectId,
      taskId,
      attemptId,
      role: 'CODER',
      roleProfileId,
      agentProfileId,
      selectedProviderId: providerId,
      selectedAccountId: accountId,
      selectedResourceId: resourceId,
      selectedAssignmentId: assignmentId,
      selectedWorkerSlotId: slotId,
      outcome: 'SELECTED',
      fallbackChain: [],
      score: 100,
      status: 'SELECTED',
      reason: 'Initial assignment',
    }
  );

  const canonicalPayload = computeCanonicalPayload({
    projectId,
    taskId,
    attemptId,
    taskTitle: 'Obs Task',
    taskDescription: 'Obs Task Description',
    acceptanceCriteria: ['must pass tests'],
    constraints: [],
    instructions: ['Implement feature'],
    contextFiles: ['README.md'],
    verificationCommands: { TEST: null, LINT: null, BUILD: null },
    managerMessageId,
    managerPayloadHash,
  });

  repo.createExecutionAuthorization({
    id: authId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    task_revision: 1,
    base_sha: baseSha,
    repository_head_sha: baseSha,
    manager_message_id: managerMessageId,
    manager_payload_hash: managerPayloadHash,
    routing_decision_id: routingDecisionId,
    selected_resource_id: resourceId,
    selected_provider_id: providerId,
    canonical_instructions_json: JSON.stringify(['Implement feature']),
    context_files_json: JSON.stringify(['README.md']),
    canonical_payload_json: JSON.stringify(canonicalPayload),
    instruction_payload_hash: computePayloadHash(canonicalPayload),
    context_manifest_hash: computeContextManifestHash(['README.md']),
    status: 'DISPATCHED',
    dispatched_at: now,
    created_at: now,
  });

  return {
    projectId,
    taskId,
    attemptId,
    slotId,
    providerId,
    accountId,
    resourceId,
    assignmentId,
    authId,
    routingDecisionId,
    repoDir,
    baseSha,
  };
}

function buildTrustedResult(
  hierarchy: ReturnType<typeof createHierarchy>,
  overrides?: {
    status?: string;
    errorCode?: string;
    error?: string;
    rawResponse?: string;
    adapterInvocation?: 'RETURNED' | 'THREW';
    executionId?: string;
    provenanceOverrides?: Partial<ProviderExecutionProvenanceV1>;
  }
): ProviderDispatchExecutionResult {
  const executionId = overrides?.executionId ?? crypto.randomUUID();
  const provenance: ProviderExecutionProvenanceV1 = {
    version: 1,
    source: 'PROVIDER_DISPATCH_SERVICE',
    mode: 'SCHEDULED',
    adapterInvocation: overrides?.adapterInvocation ?? 'RETURNED',
    authorizationId: hierarchy.authId,
    executionId,
    projectId: hierarchy.projectId,
    taskId: hierarchy.taskId,
    attemptId: hierarchy.attemptId,
    routingDecisionId: hierarchy.routingDecisionId,
    providerId: hierarchy.providerId,
    resourceId: hierarchy.resourceId,
    assignmentId: hierarchy.assignmentId,
    accountId: hierarchy.accountId,
    ...(overrides?.provenanceOverrides ?? {}),
  };

  return {
    executionId,
    status: (overrides?.status as any) ?? 'COMPLETED',
    errorCode: (overrides?.errorCode as any) ?? undefined,
    error: overrides?.error ?? undefined,
    rawResponse: overrides?.rawResponse ?? 'Raw output',
    providerExecutionProvenance: provenance,
  };
}

function buildValidObservation(
  hierarchy: ReturnType<typeof createHierarchy>,
  overrides?: Partial<ProviderHealthObservation>
): ProviderHealthObservation {
  return {
    authorization_id: hierarchy.authId,
    execution_id: crypto.randomUUID(),
    account_id: hierarchy.accountId,
    provider_id: hierarchy.providerId,
    resource_id: hierarchy.resourceId,
    assignment_id: hierarchy.assignmentId,
    attempt_id: hierarchy.attemptId,
    routing_decision_id: hierarchy.routingDecisionId,
    provenance_version: 1,
    provenance_source: 'PROVIDER_DISPATCH_SERVICE',
    mode: 'SCHEDULED',
    adapter_invocation: 'RETURNED',
    result_status: 'COMPLETED',
    classified_category: 'SUCCESS',
    observed_at: new Date().toISOString(),
    ...(overrides ?? {}),
  };
}

describe('R5H4 Durable Provider Health Observation Contract', () => {
  let tempBaseDir: string;
  let repoDir: string;
  let managedDir: string;
  let baseSha: string;
  let worktreeService: GitWorktreeService;
  let db: Database.Database;
  let repo: Repository;
  let service: ProviderHealthObservationService;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-obs-test-'));
    repoDir = path.join(tempBaseDir, 'repo');
    managedDir = path.join(tempBaseDir, 'managed');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    repoDir = fs.realpathSync.native ? fs.realpathSync.native(repoDir) : fs.realpathSync(repoDir);
    managedDir = fs.realpathSync.native ? fs.realpathSync.native(managedDir) : fs.realpathSync(managedDir);

    const gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" config user.name "Test User"`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" config user.email "test@example.com"`, { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repository\n');
    execSync(`"${gitExe}" add README.md`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" commit -m "Initial commit"`, { cwd: repoDir, stdio: 'pipe' });
    baseSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();

    worktreeService = new GitWorktreeService({
      gitExecutable: gitExe,
      repositoryRoot: repoDir,
      managedRoot: managedDir,
    });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    service = new ProviderHealthObservationService(repo);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  // 1. Valid COMPLETED records SUCCESS
  it('1. valid COMPLETED records SUCCESS', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, { status: 'COMPLETED' });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('SUCCESS');
    expect(ingest.observation?.result_status).toBe('COMPLETED');
    expect(ingest.observation?.authorization_id).toBe(hierarchy.authId);

    const stored = repo.getProviderHealthObservation(hierarchy.authId);
    expect(stored?.classified_category).toBe('SUCCESS');
  });

  // 2. Valid QUOTA_EXHAUSTED records QUOTA_EXHAUSTED
  it('2. valid QUOTA_EXHAUSTED records QUOTA_EXHAUSTED', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Daily quota has been reached for account.',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('QUOTA_EXHAUSTED');
  });

  // 3. Classifier-derived RATE_LIMITED persists RATE_LIMITED
  it('3. classifier-derived RATE_LIMITED persists RATE_LIMITED', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Resource has been exhausted (e.g. check quota) - 429 Too Many Requests rate limit exceeded',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('RATE_LIMITED');
  });

  // 4. Raw provider error text is not persisted in database
  it('4. raw provider error text is not persisted in database', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const sensitiveError = 'SECRET_TOKEN_429: https://api.openai.com/v1/key=sk-1234567890';
    const result = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'EXECUTION_FAILED',
      error: sensitiveError,
      rawResponse: 'RAW_LEAK: my_super_secret_password',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');

    const row = db.prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?').get(hierarchy.authId) as any;
    expect(row).toBeDefined();
    const rowString = JSON.stringify(row);
    expect(rowString).not.toContain('SECRET_TOKEN');
    expect(rowString).not.toContain('RAW_LEAK');
    expect(rowString).not.toContain('sk-1234567890');
    expect(rowString).not.toContain('password');
  });

  // 5. AUTH_ERROR records AUTHENTICATION_FAILURE
  it('5. AUTH_ERROR records AUTHENTICATION_FAILURE', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      error: 'Invalid API credentials supplied.',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('AUTHENTICATION_FAILURE');
  });

  // 6. RESOURCE_UNAVAILABLE records category only
  it('6. RESOURCE_UNAVAILABLE records category only', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'RESOURCE_UNAVAILABLE',
      error: 'Capacity offline in us-east-1',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('RESOURCE_UNAVAILABLE');
  });

  // 7. CANCELLED records CANCELLED
  it('7. CANCELLED records CANCELLED', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'CANCELLED',
      errorCode: 'CANCELLED',
      error: 'Execution cancelled by supervisor.',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('CANCELLED');
  });

  // 8. AWAITING_OWNER records AWAITING_OWNER
  it('8. AWAITING_OWNER records AWAITING_OWNER', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'AWAITING_OWNER',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('AWAITING_OWNER');
  });

  // 9. THREW records ADAPTER_THROW
  it('9. THREW records ADAPTER_THROW', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'EXECUTION_FAILED',
      adapterInvocation: 'THREW',
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation?.classified_category).toBe('ADAPTER_THROW');
    expect(ingest.observation?.adapter_invocation).toBe('THREW');
  });

  // 10. No provenance => no row
  it('10. no provenance => no row', () => {
    createHierarchy(repo, repoDir, baseSha);
    const result: ProviderDispatchExecutionResult = {
      executionId: crypto.randomUUID(),
      status: 'COMPLETED',
    };

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('NOT_APPLICABLE');
    expect(ingest.observation).toBeNull();
    const rows = db.prepare('SELECT COUNT(*) as count FROM provider_health_observations').get() as { count: number };
    expect(rows.count).toBe(0);
  });

  // 11. Null account => no row
  it('11. null account => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { accountId: null },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('NOT_APPLICABLE');
    expect(ingest.observation).toBeNull();
    const rows = db.prepare('SELECT COUNT(*) as count FROM provider_health_observations').get() as { count: number };
    expect(rows.count).toBe(0);
  });

  // 12. Malformed version => no row
  it('12. malformed version => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { version: 2 as any },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
    expect(ingest.observation).toBeNull();
  });

  // 13. Malformed source => no row
  it('13. malformed source => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { source: 'OTHER_SERVICE' as any },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 14. Malformed adapterInvocation => no row
  it('14. malformed adapterInvocation => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { adapterInvocation: 'INVALID' as any },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 15. ExecutionId mismatch => no row
  it('15. executionId mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      executionId: 'exec-1',
      provenanceOverrides: { executionId: 'exec-2' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 16. Authorization missing => no row
  it('16. authorization missing => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { authorizationId: 'non-existent-auth' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 17. Authorization not DISPATCHED => no row
  it('17. authorization not DISPATCHED => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);
    const result = buildTrustedResult(hierarchy);

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 18. Auth project mismatch => no row
  it('18. auth project mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { projectId: 'other-project' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 19. Auth task mismatch => no row
  it('19. auth task mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { taskId: 'other-task' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 20. Auth attempt mismatch => no row
  it('20. auth attempt mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { attemptId: 'other-attempt' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 21. Auth routing mismatch => no row
  it('21. auth routing mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { routingDecisionId: 'other-decision' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 22. Auth provider mismatch => no row
  it('22. auth provider mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { providerId: 'other-provider' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 23. Auth resource mismatch => no row
  it('23. auth resource mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { resourceId: 'other-resource' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 24. Assignment missing => no row
  it('24. assignment missing => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { assignmentId: 'non-existent-assignment' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 25. Assignment account mismatch => no row
  it('25. assignment account mismatch => no row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      provenanceOverrides: { accountId: 'other-account' },
    });

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('REJECTED');
  });

  // 26. First insert => RECORDED
  it('26. first insert => RECORDED', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy);

    const ingest = service.recordObservation(result);
    expect(ingest.status).toBe('RECORDED');
    expect(ingest.observation).not.toBeNull();
  });

  // 27. Duplicate identical => ALREADY_RECORDED and one row
  it('27. duplicate identical => ALREADY_RECORDED and one row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy);

    const ingest1 = service.recordObservation(result);
    expect(ingest1.status).toBe('RECORDED');

    const ingest2 = service.recordObservation(result);
    expect(ingest2.status).toBe('ALREADY_RECORDED');

    const count = (db.prepare('SELECT COUNT(*) as count FROM provider_health_observations WHERE authorization_id = ?').get(hierarchy.authId) as any).count;
    expect(count).toBe(1);
  });

  // 28. Duplicate changed category => integrity mismatch and one row
  it('28. duplicate changed category => integrity mismatch and one row', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result1 = buildTrustedResult(hierarchy, { status: 'COMPLETED' });
    const ingest1 = service.recordObservation(result1);
    expect(ingest1.status).toBe('RECORDED');

    const result2 = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      executionId: result1.executionId,
    });

    expect(() => service.recordObservation(result2)).toThrow(/OBSERVATION_INTEGRITY_MISMATCH/);

    const count = (db.prepare('SELECT COUNT(*) as count FROM provider_health_observations WHERE authorization_id = ?').get(hierarchy.authId) as any).count;
    expect(count).toBe(1);
  });

  // 29. Restart/new Repository reads same observation from file-backed SQLite
  it('29. restart/new Repository reads same observation from file-backed SQLite', () => {
    const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-obs-restart-'));
    const dbPath = path.join(tempDbDir, 'agentforge.db');

    try {
      const db1 = new Database(dbPath);
      db1.pragma('foreign_keys = ON');
      MigrationRunner.run(db1);
      const repo1 = new Repository(db1);
      const service1 = new ProviderHealthObservationService(repo1);

      const hierarchy = createHierarchy(repo1, repoDir, baseSha);
      const result = buildTrustedResult(hierarchy, { status: 'COMPLETED' });
      service1.recordObservation(result);
      db1.close();

      const db2 = new Database(dbPath);
      db2.pragma('foreign_keys = ON');
      const repo2 = new Repository(db2);
      const obs = repo2.getProviderHealthObservation(hierarchy.authId);

      expect(obs).not.toBeNull();
      expect(obs?.authorization_id).toBe(hierarchy.authId);
      expect(obs?.classified_category).toBe('SUCCESS');
      expect(obs?.account_id).toBe(hierarchy.accountId);
      db2.close();
    } finally {
      try {
        fs.rmSync(tempDbDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // 30. EventService undefined still allows real ProviderDispatch observation
  it('30. EventService undefined still allows real ProviderDispatch observation', async () => {
    const registry = new ProviderRegistry();
    const adapter = new MockAdapter('prov-test-obs', 'Obs Provider');
    registry.register(adapter);

    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

    const dispatch = new ProviderDispatchService(registry, repo, undefined);

    const res = await dispatch.dispatch(hierarchy.authId);
    expect(res.status).toBe('COMPLETED');

    const obs = repo.getProviderHealthObservation(hierarchy.authId);
    expect(obs).not.toBeNull();
    expect(obs?.classified_category).toBe('SUCCESS');
  });

  // 31. Real dispatch COMPLETED writes observation
  it('31. real dispatch COMPLETED writes observation', async () => {
    const registry = new ProviderRegistry();
    const adapter = new MockAdapter('prov-test-obs', 'Obs Provider');
    registry.register(adapter);
    const eventService = new EventService(repo);

    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

    const dispatch = new ProviderDispatchService(registry, repo, eventService);

    const res = await dispatch.dispatch(hierarchy.authId);
    expect(res.status).toBe('COMPLETED');
    expect(res.providerExecutionProvenance).toBeDefined();

    const obs = repo.getProviderHealthObservation(hierarchy.authId);
    expect(obs).not.toBeNull();
    expect(obs?.classified_category).toBe('SUCCESS');
    expect(obs?.execution_id).toBe(res.executionId);
  });

  // 32. Real dispatch provider failure writes classified observation
  it('32. real dispatch provider failure writes classified observation', async () => {
    const registry = new ProviderRegistry();
    const adapter = new MockAdapter('prov-test-obs', 'Obs Provider');
    adapter.executeResult = {
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: '429 Too Many Requests - rate limit exceeded',
    };
    registry.register(adapter);

    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

    const dispatch = new ProviderDispatchService(registry, repo);

    const res = await dispatch.dispatch(hierarchy.authId);
    expect(res.status).toBe('FAILED');

    const obs = repo.getProviderHealthObservation(hierarchy.authId);
    expect(obs).not.toBeNull();
    expect(obs?.classified_category).toBe('RATE_LIMITED');
  });

  // 33. Pre-adapter dispatch rejection writes no observation
  it('33. pre-adapter dispatch rejection writes no observation', async () => {
    const registry = new ProviderRegistry();
    // Do NOT register adapter -> adapter unregistered pre-adapter rejection
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

    const dispatch = new ProviderDispatchService(registry, repo);

    const res = await dispatch.dispatch(hierarchy.authId);
    expect(res.status).toBe('FAILED');
    expect(res.providerExecutionProvenance).toBeUndefined();

    const obs = repo.getProviderHealthObservation(hierarchy.authId);
    expect(obs).toBeNull();
  });

  // 34. Post-claim/pre-adapter cancellation writes no observation
  it('34. post-claim/pre-adapter cancellation writes no observation', async () => {
    const registry = new ProviderRegistry();
    const adapter = new MockAdapter('prov-test-obs', 'Obs Provider');
    registry.register(adapter);

    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

    const worktreeTuple = {
      projectId: hierarchy.projectId,
      taskId: hierarchy.taskId,
      attemptId: hierarchy.attemptId,
      assignmentId: hierarchy.assignmentId,
      workerSlotId: hierarchy.slotId,
      baseSha: hierarchy.baseSha,
    };
    await worktreeService.createWorktree(worktreeTuple);

    const dispatch = new ProviderDispatchService(registry, repo, undefined, worktreeService);

    const origClaim = repo.claimExecutionAuthorization.bind(repo);
    repo.claimExecutionAuthorization = (id: string, now: string) => {
      const res = origClaim(id, now);
      if (res) {
        void dispatch.cancelScheduled(hierarchy.authId);
      }
      return res;
    };

    try {
      const res = await dispatch.dispatchScheduled(hierarchy.authId);
      expect(res.status).toBe('CANCELLED');
      expect(res.providerExecutionProvenance).toBeUndefined();

      const obs = repo.getProviderHealthObservation(hierarchy.authId);
      expect(obs).toBeNull();
    } finally {
      repo.claimExecutionAuthorization = origClaim;
      await worktreeService.removeWorktree(worktreeTuple);
    }
  });

  // 35. Observation failure does not alter provider result/provenance
  it('35. observation failure does not alter provider result/provenance', async () => {
    const registry = new ProviderRegistry();
    const adapter = new MockAdapter('prov-test-obs', 'Obs Provider');
    registry.register(adapter);

    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

    const dispatch = new ProviderDispatchService(registry, repo);

    // Spy on observation service to throw
    const obsService = (dispatch as any).observationService;
    obsService.recordObservation = () => {
      throw new Error('SIMULATED_DB_ERROR: Disk full');
    };

    const res = await dispatch.dispatch(hierarchy.authId);
    expect(res.status).toBe('COMPLETED');
    expect(res.providerExecutionProvenance).toBeDefined();
    expect(res.providerExecutionProvenance?.authorizationId).toBe(hierarchy.authId);
  });

  // 36. Source scan proves no AccountHealthService/policy/failover imports
  it('36. source scan proves no AccountHealthService/policy/failover imports in observation service', () => {
    const serviceFilePath = path.join(__dirname, '../src/core/services/ProviderHealthObservationService.ts');
    const content = fs.readFileSync(serviceFilePath, 'utf8');

    expect(content).not.toContain('AccountHealthService');
    expect(content).not.toContain('FailureHealthMutationPolicyService');
    expect(content).not.toContain('FailoverDecision');
    expect(content).not.toContain('FailoverPolicy');
    expect(content).not.toContain('ConcurrentExecutionScheduler');
    expect(content).not.toContain('updateProviderAccountHealth');
  });

  // 37. Genuine SQLite two-connection write contention proof
  it('37. genuine SQLite two-connection write contention proof', () => {
    const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-concurrent-obs-'));
    const dbPath = path.join(tempDbDir, 'concurrent.db');

    try {
      const db1 = new Database(dbPath);
      db1.pragma('foreign_keys = ON');
      MigrationRunner.run(db1);
      const repo1 = new Repository(db1);
      const hierarchy = createHierarchy(repo1, repoDir, baseSha);

      const db2 = new Database(dbPath);
      db2.pragma('foreign_keys = ON');
      db2.pragma('busy_timeout = 0'); // Fail immediately on write lock contention
      const repo2 = new Repository(db2);

      const obs: ProviderHealthObservation = {
        authorization_id: hierarchy.authId,
        execution_id: crypto.randomUUID(),
        account_id: hierarchy.accountId,
        provider_id: hierarchy.providerId,
        resource_id: hierarchy.resourceId,
        assignment_id: hierarchy.assignmentId,
        attempt_id: hierarchy.attemptId,
        routing_decision_id: hierarchy.routingDecisionId,
        provenance_version: 1,
        provenance_source: 'PROVIDER_DISPATCH_SERVICE',
        mode: 'SCHEDULED',
        adapter_invocation: 'RETURNED',
        result_status: 'COMPLETED',
        classified_category: 'SUCCESS',
        observed_at: new Date().toISOString(),
      };

      // Step 1: db1 acquires write reservation via BEGIN IMMEDIATE
      db1.exec('BEGIN IMMEDIATE');

      // Step 2: while db1 holds write lock, db2 attempts claimProviderHealthObservation (which uses runInImmediateTransaction)
      // With busy_timeout = 0, db2 cannot acquire write lock and must throw SQLITE_BUSY / database locked
      expect(() => {
        repo2.claimProviderHealthObservation(obs);
      }).toThrow(/database is locked|busy/i);

      // Verify no observation was inserted on db2 or db1
      expect(repo1.getProviderHealthObservation(hierarchy.authId)).toBeNull();

      // Step 3: db1 rolls back / releases the held write reservation
      db1.exec('ROLLBACK');

      // Step 4: After lock release, perform one claim on db1 -> RECORDED
      const res1 = repo1.claimProviderHealthObservation(obs);
      expect(res1).toBe('RECORDED');

      // Step 5: Perform second identical claim on db2 -> ALREADY_RECORDED
      const res2 = repo2.claimProviderHealthObservation(obs);
      expect(res2).toBe('ALREADY_RECORDED');

      // Final row count: exactly 1
      const count = (db1.prepare('SELECT COUNT(*) as count FROM provider_health_observations WHERE authorization_id = ?').get(hierarchy.authId) as any).count;
      expect(count).toBe(1);

      db1.close();
      db2.close();
    } finally {
      try {
        fs.rmSync(tempDbDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // 38. Security scan proves no secrets or raw outputs in observation table
  it('38. security scan proves no secrets or raw outputs in observation table', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const result = buildTrustedResult(hierarchy, {
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      error: 'Bearer auth_token_secret_12345 invalid',
      rawResponse: 'Raw stderr: token=sk-xyz password=hunter2',
    });

    service.recordObservation(result);

    const row = db.prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?').get(hierarchy.authId) as any;
    const columns = Object.keys(row);
    expect(columns).not.toContain('error');
    expect(columns).not.toContain('raw_response');
    expect(columns).not.toContain('stdout');
    expect(columns).not.toContain('stderr');
    expect(columns).not.toContain('credential_ref');
    expect(columns).not.toContain('profile_ref');

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('auth_token_secret_12345');
    expect(serialized).not.toContain('sk-xyz');
    expect(serialized).not.toContain('hunter2');
  });

  // 39. Atomic validation race / TOCTOU closed proof
  it('39. atomic validation race / TOCTOU closed proof: concurrent writer cannot leave stale pre-read', () => {
    const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-toctou-obs-'));
    const dbPath = path.join(tempDbDir, 'toctou.db');

    try {
      const db1 = new Database(dbPath);
      db1.pragma('foreign_keys = ON');
      MigrationRunner.run(db1);
      const repo1 = new Repository(db1);
      const hierarchy = createHierarchy(repo1, repoDir, baseSha);

      const db2 = new Database(dbPath);
      db2.pragma('foreign_keys = ON');
      db2.pragma('busy_timeout = 0');
      const repo2 = new Repository(db2);

      const obs: ProviderHealthObservation = {
        authorization_id: hierarchy.authId,
        execution_id: crypto.randomUUID(),
        account_id: hierarchy.accountId,
        provider_id: hierarchy.providerId,
        resource_id: hierarchy.resourceId,
        assignment_id: hierarchy.assignmentId,
        attempt_id: hierarchy.attemptId,
        routing_decision_id: hierarchy.routingDecisionId,
        provenance_version: 1,
        provenance_source: 'PROVIDER_DISPATCH_SERVICE',
        mode: 'SCHEDULED',
        adapter_invocation: 'RETURNED',
        result_status: 'COMPLETED',
        classified_category: 'SUCCESS',
        observed_at: new Date().toISOString(),
      };

      // Handle 1 holds BEGIN IMMEDIATE and changes authorization status away from DISPATCHED uncommitted
      db1.exec('BEGIN IMMEDIATE');
      db1.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

      // Handle 2 atomic claim cannot proceed while handle 1 holds immediate lock
      expect(() => {
        repo2.claimProviderHealthObservation(obs);
      }).toThrow(/database is locked|busy/i);

      // Handle 1 commits the change
      db1.exec('COMMIT');

      // Now Handle 2 tries, and fails validation because authorization is no longer DISPATCHED
      expect(() => {
        repo2.claimProviderHealthObservation(obs);
      }).toThrow(/AUTHORIZATION_NOT_DISPATCHED/);

      expect(repo2.getProviderHealthObservation(hierarchy.authId)).toBeNull();

      db1.close();
      db2.close();
    } finally {
      try {
        fs.rmSync(tempDbDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // 40. Raw claim fails closed when authorization status != DISPATCHED
  it('40. raw claim fails closed when authorization status != DISPATCHED', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(hierarchy.authId);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/AUTHORIZATION_NOT_DISPATCHED/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 41. Raw claim fails closed when authorization does not exist
  it('41. raw claim fails closed when authorization does not exist', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: 'non-existent-auth',
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/AUTHORIZATION_NOT_FOUND/);
    expect(repo.getProviderHealthObservation('non-existent-auth')).toBeNull();
  });

  // 42. Raw claim fails closed when authorization routing_decision_id mismatches observation
  it('42. raw claim fails closed when authorization routing_decision_id mismatches observation', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: 'other-rd-id',
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ROUTING_DECISION_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 43. Raw claim fails closed when authorization selected_provider_id mismatches observation
  it('43. raw claim fails closed when authorization selected_provider_id mismatches observation', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: 'other-provider',
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/PROVIDER_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 44. Raw claim fails closed when authorization selected_resource_id mismatches observation
  it('44. raw claim fails closed when authorization selected_resource_id mismatches observation', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: 'other-resource',
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/RESOURCE_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 45. Raw claim fails closed when authorization attempt_id mismatches observation
  it('45. raw claim fails closed when authorization attempt_id mismatches observation', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: 'other-attempt',
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ATTEMPT_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 46. Raw claim fails closed when assignment does not exist
  it('46. raw claim fails closed when assignment does not exist', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: 'non-existent-assignment',
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ASSIGNMENT_NOT_FOUND/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 47. Raw claim fails closed when assignment project_id mismatches authorization project_id
  it('47. raw claim fails closed when assignment project_id mismatches authorization project_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createProject({
      id: 'proj-foreign',
      name: 'Foreign Project',
      description: null,
      contract: null,
      repository_path: repoDir,
      default_branch: 'main',
      status: 'RUNNING',
      started_at: now,
      completed_at: null,
      created_at: now,
      updated_at: now,
    });
    repo.createTask({
      id: 'task-proj-foreign',
      project_id: 'proj-foreign',
      milestone_id: null,
      title: 'Foreign Task',
      description: 'Foreign Task Desc',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: baseSha,
      current_sha: baseSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      constraints: [],
      acceptance_criteria: ['pass tests'],
      created_at: now,
      updated_at: now,
    });
    const asgnId = 'assign-foreign-proj';
    repo.createAgentAssignment({
      id: asgnId,
      project_id: 'proj-foreign',
      task_id: 'task-proj-foreign',
      attempt_id: null,
      role_profile_id: 'role-obs-1',
      agent_profile_id: 'prof-obs-1',
      selected_provider_id: hierarchy.providerId,
      selected_account_id: hierarchy.accountId,
      selected_resource_id: hierarchy.resourceId,
      selected_worker_slot_id: hierarchy.slotId,
      routing_decision_id: hierarchy.routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const obs = buildValidObservation(hierarchy, { assignment_id: asgnId });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/PROJECT_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 48. Raw claim fails closed when assignment task_id mismatches authorization task_id
  it('48. raw claim fails closed when assignment task_id mismatches authorization task_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createTask({
      id: 'task-foreign',
      project_id: hierarchy.projectId,
      milestone_id: null,
      title: 'Foreign Task',
      description: 'Foreign Task Desc',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: baseSha,
      current_sha: baseSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      constraints: [],
      acceptance_criteria: ['pass tests'],
      created_at: now,
      updated_at: now,
    });
    const asgnId = 'assign-foreign-task';
    repo.createAgentAssignment({
      id: asgnId,
      project_id: hierarchy.projectId,
      task_id: 'task-foreign',
      attempt_id: null,
      role_profile_id: 'role-obs-1',
      agent_profile_id: 'prof-obs-1',
      selected_provider_id: hierarchy.providerId,
      selected_account_id: hierarchy.accountId,
      selected_resource_id: hierarchy.resourceId,
      selected_worker_slot_id: hierarchy.slotId,
      routing_decision_id: hierarchy.routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const obs = buildValidObservation(hierarchy, { assignment_id: asgnId });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/TASK_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 49. Raw claim fails closed when assignment attempt_id mismatches authorization attempt_id
  it('49. raw claim fails closed when assignment attempt_id mismatches authorization attempt_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createTaskAttempt({
      id: 'att-foreign',
      task_id: hierarchy.taskId,
      agent_id: 'agent-obs-1',
      attempt_number: 2,
      status: 'RUNNING',
      started_at: now,
      ended_at: null,
      summary: null,
    });
    const asgnId = 'assign-foreign-attempt';
    repo.createAgentAssignment({
      id: asgnId,
      project_id: hierarchy.projectId,
      task_id: hierarchy.taskId,
      attempt_id: 'att-foreign',
      role_profile_id: 'role-obs-1',
      agent_profile_id: 'prof-obs-1',
      selected_provider_id: hierarchy.providerId,
      selected_account_id: hierarchy.accountId,
      selected_resource_id: hierarchy.resourceId,
      selected_worker_slot_id: hierarchy.slotId,
      routing_decision_id: hierarchy.routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const obs = buildValidObservation(hierarchy, { assignment_id: asgnId });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ATTEMPT_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 50. Raw claim fails closed when assignment routing_decision_id mismatches authorization routing_decision_id
  it('50. raw claim fails closed when assignment routing_decision_id mismatches authorization routing_decision_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    const asgnId = 'assign-foreign-rd';
    repo.createAgentAssignment({
      id: asgnId,
      project_id: hierarchy.projectId,
      task_id: hierarchy.taskId,
      attempt_id: hierarchy.attemptId,
      role_profile_id: 'role-obs-1',
      agent_profile_id: 'prof-obs-1',
      selected_provider_id: hierarchy.providerId,
      selected_account_id: hierarchy.accountId,
      selected_resource_id: hierarchy.resourceId,
      selected_worker_slot_id: hierarchy.slotId,
      routing_decision_id: 'rd-foreign',
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const obs = buildValidObservation(hierarchy, { assignment_id: asgnId });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ROUTING_DECISION_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 51. Raw claim fails closed when assignment selected_account_id mismatches observation account_id
  it('51. raw claim fails closed when assignment selected_account_id mismatches observation account_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createProviderAccount({
      id: 'acc-foreign',
      provider_id: hierarchy.providerId,
      label: 'Foreign Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://gemini/g02',
      enabled: true,
      priority: 2,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: now,
      updated_at: now,
    });
    repo.createProviderResource({
      id: 'res-foreign-acc',
      provider_id: hierarchy.providerId,
      provider_account_id: 'acc-foreign',
      model_name: 'gemini-1.5-flash',
      capabilities: ['CODING'],
      enabled: true,
      health_status: 'AVAILABLE',
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'requests',
      quota_reset_at: null,
      quota_source: 'ESTIMATED',
      quota_confidence: 1.0,
      last_health_check: now,
    });
    repo.createWorkerSlot({
      id: 'slot-foreign-acc',
      provider_account_id: 'acc-foreign',
      provider_resource_id: 'res-foreign-acc',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });
    const asgnId = 'assign-foreign-acc';
    repo.createAgentAssignment({
      id: asgnId,
      project_id: hierarchy.projectId,
      task_id: hierarchy.taskId,
      attempt_id: hierarchy.attemptId,
      role_profile_id: 'role-obs-1',
      agent_profile_id: 'prof-obs-1',
      selected_provider_id: hierarchy.providerId,
      selected_account_id: 'acc-foreign',
      selected_resource_id: 'res-foreign-acc',
      selected_worker_slot_id: 'slot-foreign-acc',
      routing_decision_id: hierarchy.routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const obs = buildValidObservation(hierarchy, { assignment_id: asgnId });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ASSIGNMENT_ACCOUNT_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 52. Raw claim fails closed when assignment selected_provider_id mismatches observation provider_id
  it('52. raw claim fails closed when assignment selected_provider_id mismatches observation provider_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createProvider({
      id: 'prov-foreign',
      name: 'Foreign Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    });
    repo.createProviderAccount({
      id: 'acc-foreign-prov',
      provider_id: 'prov-foreign',
      label: 'Foreign Prov Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://gemini/g02',
      enabled: true,
      priority: 2,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: now,
      updated_at: now,
    });
    repo.createProviderResource({
      id: 'res-foreign-prov',
      provider_id: 'prov-foreign',
      provider_account_id: 'acc-foreign-prov',
      model_name: 'gemini-1.5-flash',
      capabilities: ['CODING'],
      enabled: true,
      health_status: 'AVAILABLE',
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'requests',
      quota_reset_at: null,
      quota_source: 'ESTIMATED',
      quota_confidence: 1.0,
      last_health_check: now,
    });
    repo.createWorkerSlot({
      id: 'slot-foreign-prov',
      provider_account_id: 'acc-foreign-prov',
      provider_resource_id: 'res-foreign-prov',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });
    const asgnId = 'assign-foreign-prov';
    repo.createAgentAssignment({
      id: asgnId,
      project_id: hierarchy.projectId,
      task_id: hierarchy.taskId,
      attempt_id: hierarchy.attemptId,
      role_profile_id: 'role-obs-1',
      agent_profile_id: 'prof-obs-1',
      selected_provider_id: 'prov-foreign',
      selected_account_id: 'acc-foreign-prov',
      selected_resource_id: 'res-foreign-prov',
      selected_worker_slot_id: 'slot-foreign-prov',
      routing_decision_id: hierarchy.routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const obs = buildValidObservation(hierarchy, { assignment_id: asgnId });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ASSIGNMENT_PROVIDER_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 53. Raw claim fails closed when assignment selected_resource_id mismatches observation resource_id
  it('53. raw claim fails closed when assignment selected_resource_id mismatches observation resource_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createProviderResource({
      id: 'res-foreign',
      provider_id: hierarchy.providerId,
      provider_account_id: hierarchy.accountId,
      model_name: 'gemini-1.5-flash',
      capabilities: ['CODING'],
      enabled: true,
      health_status: 'AVAILABLE',
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'requests',
      quota_reset_at: null,
      quota_source: 'ESTIMATED',
      quota_confidence: 1.0,
      last_health_check: now,
    });
    repo.createWorkerSlot({
      id: 'slot-foreign-res',
      provider_account_id: hierarchy.accountId,
      provider_resource_id: 'res-foreign',
      slot_index: 1,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });
    const asgnId = 'assign-foreign-res';
    repo.createAgentAssignment({
      id: asgnId,
      project_id: hierarchy.projectId,
      task_id: hierarchy.taskId,
      attempt_id: hierarchy.attemptId,
      role_profile_id: 'role-obs-1',
      agent_profile_id: 'prof-obs-1',
      selected_provider_id: hierarchy.providerId,
      selected_account_id: hierarchy.accountId,
      selected_resource_id: 'res-foreign',
      selected_worker_slot_id: 'slot-foreign-res',
      routing_decision_id: hierarchy.routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const obs = buildValidObservation(hierarchy, { assignment_id: asgnId });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ASSIGNMENT_RESOURCE_ID_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 54. Raw claim fails closed when task_attempt does not exist for non-null attempt_id
  it('54. raw claim fails closed when task_attempt does not exist for non-null attempt_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.prepare('DELETE FROM task_attempts WHERE id = ?').run(hierarchy.attemptId);
    db.prepare('PRAGMA foreign_keys = ON').run();

    const obs = buildValidObservation(hierarchy);
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/TASK_ATTEMPT_NOT_FOUND/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 55. Raw claim fails closed when task_attempt task_id mismatches authorization task_id
  it('55. raw claim fails closed when task_attempt task_id mismatches authorization task_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createTask({
      id: 'task-foreign',
      project_id: hierarchy.projectId,
      milestone_id: null,
      title: 'Foreign Task',
      description: 'Foreign Task Desc',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: baseSha,
      current_sha: baseSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      constraints: [],
      acceptance_criteria: ['pass tests'],
      created_at: now,
      updated_at: now,
    });
    repo.createTaskAttempt({
      id: 'att-foreign',
      task_id: 'task-foreign',
      agent_id: 'agent-obs-1',
      attempt_number: 1,
      status: 'RUNNING',
      started_at: now,
      ended_at: null,
      summary: null,
    });
    db.prepare('UPDATE execution_authorizations SET attempt_id = ? WHERE id = ?').run('att-foreign', hierarchy.authId);
    db.prepare('UPDATE agent_assignments SET attempt_id = ? WHERE id = ?').run('att-foreign', hierarchy.assignmentId);

    const obs = buildValidObservation(hierarchy, { attempt_id: 'att-foreign' });
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/TASK_ATTEMPT_TASK_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 56. Raw claim fails closed when provider_account does not exist
  it('56. raw claim fails closed when provider_account does not exist', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(hierarchy.accountId);
    db.prepare('PRAGMA foreign_keys = ON').run();

    const obs = buildValidObservation(hierarchy);
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/PROVIDER_ACCOUNT_NOT_FOUND/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 57. Raw claim fails closed when provider_account provider_id mismatches observation provider_id
  it('57. raw claim fails closed when provider_account provider_id mismatches observation provider_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createProvider({
      id: 'prov-foreign',
      name: 'Foreign Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    });
    db.prepare('UPDATE provider_accounts SET provider_id = ? WHERE id = ?').run('prov-foreign', hierarchy.accountId);

    const obs = buildValidObservation(hierarchy);
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/ACCOUNT_PROVIDER_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 58. Raw claim fails closed when provider does not exist
  it('58. raw claim fails closed when provider does not exist', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.prepare('DELETE FROM providers WHERE id = ?').run(hierarchy.providerId);
    db.prepare('PRAGMA foreign_keys = ON').run();

    const obs = buildValidObservation(hierarchy);
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/PROVIDER_NOT_FOUND/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 59. Raw claim fails closed when provider_resource does not exist
  it('59. raw claim fails closed when provider_resource does not exist', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.prepare('DELETE FROM provider_resources WHERE id = ?').run(hierarchy.resourceId);
    db.prepare('PRAGMA foreign_keys = ON').run();

    const obs = buildValidObservation(hierarchy);
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/PROVIDER_RESOURCE_NOT_FOUND/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 60. Raw claim fails closed when provider_resource provider_id mismatches observation provider_id
  it('60. raw claim fails closed when provider_resource provider_id mismatches observation provider_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createProvider({
      id: 'prov-foreign',
      name: 'Foreign Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    });
    db.prepare('UPDATE provider_resources SET provider_id = ? WHERE id = ?').run('prov-foreign', hierarchy.resourceId);

    const obs = buildValidObservation(hierarchy);
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/RESOURCE_PROVIDER_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 61. Raw claim fails closed when provider_resource provider_account_id mismatches observation account_id
  it('61. raw claim fails closed when provider_resource provider_account_id mismatches observation account_id', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);
    const now = new Date().toISOString();
    repo.createProviderAccount({
      id: 'acc-foreign',
      provider_id: hierarchy.providerId,
      label: 'Foreign Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://gemini/g02',
      enabled: true,
      priority: 2,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: now,
      updated_at: now,
    });
    db.prepare('UPDATE provider_resources SET provider_account_id = ? WHERE id = ?').run('acc-foreign', hierarchy.resourceId);

    const obs = buildValidObservation(hierarchy);
    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/RESOURCE_ACCOUNT_MISMATCH/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 62. Raw claim fails closed on invalid result_status
  it('62. raw claim fails closed on invalid result_status', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FORGED_STATUS' as any,
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/INVALID_RESULT_STATUS/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 63. Raw claim fails closed on invalid classified_category
  it('63. raw claim fails closed on invalid classified_category', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'RAW_UNBOUNDED_CATEGORY' as any,
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/INVALID_CLASSIFIED_CATEGORY/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 64. Raw claim fails closed on invalid runtime shape (e.g. provenance_version != 1)
  it('64. raw claim fails closed on invalid runtime shape (e.g. provenance_version != 1)', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 2 as any,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/INVALID_OBSERVATION_SHAPE/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 65. Raw claim fails closed on invalid runtime shape (empty string fields)
  it('65. raw claim fails closed on invalid runtime shape (empty string fields)', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: '   ',
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: new Date().toISOString(),
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/INVALID_OBSERVATION_SHAPE/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });

  // 66. Raw claim fails closed on invalid observed_at timestamp
  it('66. raw claim fails closed on invalid observed_at timestamp', () => {
    const hierarchy = createHierarchy(repo, repoDir, baseSha);

    const obs: ProviderHealthObservation = {
      authorization_id: hierarchy.authId,
      execution_id: crypto.randomUUID(),
      account_id: hierarchy.accountId,
      provider_id: hierarchy.providerId,
      resource_id: hierarchy.resourceId,
      assignment_id: hierarchy.assignmentId,
      attempt_id: hierarchy.attemptId,
      routing_decision_id: hierarchy.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: 'NOT_A_DATE',
    };

    expect(() => repo.claimProviderHealthObservation(obs)).toThrow(/INVALID_OBSERVATION_SHAPE/);
    expect(repo.getProviderHealthObservation(hierarchy.authId)).toBeNull();
  });
});
