import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { execFileSync as initializeFixtureGit } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { VerificationCapabilityService } from '../src/core/services/VerificationCapabilityService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { VerificationService } from '../src/core/services/VerificationService';
import { approveFixtureCommand } from './helpers/verificationCapabilityFixture';
import { buildVerificationCommandsSnapshot, CanonicalExecutionPayload, computeCanonicalPayload, computePayloadHash } from '../src/core/services/ExecutionAuthorizationService';
import { canonicalJsonStringify } from '../src/core/context/ContextIntegrity';
import { computeSha256 } from '../src/mcp/submissionProtocol';
import { EvidenceCollector } from '../src/core/autonomy/evidence';
import { ProductTaskAutonomyAdapter, renderCommand } from '../src/core/autonomy/productTaskAdapter';
import { WorkOrderSchema } from '../src/core/autonomy/contracts';
import { TaskService } from '../src/core/services/TaskService';
import { EventService } from '../src/core/services/EventService';
import { GitService } from '../src/core/services/GitService';

describe('issued capability process boundary', () => {
  let root: string;
  let database: Database.Database;
  let service: VerificationCapabilityService;
  let repo: Repository;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-cap-process-')));
    database = new Database(':memory:');
    database.pragma('foreign_keys=ON');
    MigrationRunner.run(database);
    repo = new Repository(database);
    const now = new Date().toISOString();
    if (!fs.existsSync(path.join(root, '.git'))) initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: root, stdio: 'ignore', windowsHide: true });
    repo.createProject({ id: 'P', name: 'Process fixture', description: null, repository_path: root, default_branch: 'main',
      status: 'READY', contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null }, captureRepositoryRoot(root));
    service = new VerificationCapabilityService(repo, () => '1'.repeat(64));
    repo.createTask({ id: 'T', project_id: 'P', milestone_id: null, title: 'Verify capability', description: null, state: 'VALIDATING',
      paused_from_state: null, priority: 'HIGH', risk: 'LOW', assigned_agent_id: null, revision_count: 0, max_revisions: 3,
      base_sha: 'a'.repeat(40), current_sha: 'a'.repeat(40), progress_cache_percent: 0, progress_computed_at: null,
      acceptance_criteria: [], constraints: [], created_at: now, updated_at: now });
    repo.createProvider({ id: 'provider-fixture', name: 'Capability fixture', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
    repo.createProviderResource({ id: 'resource-fixture', provider_id: 'provider-fixture', model_name: 'fixture', health_status: 'AVAILABLE',
      capabilities: [], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null,
      quota_source: 'UNKNOWN', quota_confidence: 0, last_health_check: null });
  });
  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-cap-process-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function approve(args: string[]) {
    const payload = service.propose('P', process.execPath, args, root);
    const reference = await service.approve(payload, async () => true);
    const boundary = service.createProcessBoundary(reference, 'P', payload.executable.path, payload.args, root);
    return { payload, reference, boundary };
  }

  async function configured() {
    const command = await approveFixtureCommand(repo, 'P', ['--version']);
    repo.setProjectVerificationCommands('P', { TEST: command });
    const snapshot = buildVerificationCommandsSnapshot(repo.getVerificationCommandsByProject('P'));
    return { command, snapshot, verification: new VerificationService(repo, new ArtifactStore(path.join(root, 'artifacts'))) };
  }

  function authorize(snapshot: CanonicalExecutionPayload['verificationCommands'], worktree = root) {
    repo.recordProtocolMessage('manager', 'manager', 'manager.v1', 'P', 'T', null, null, 'b'.repeat(64), '{}', 'APPLIED');
    const resource = repo.getAllProviderResources()[0];
    const payload = computeCanonicalPayload({ projectId: 'P', taskId: 'T', attemptId: null, taskTitle: 'Verify capability',
      taskDescription: null, acceptanceCriteria: [], constraints: [], instructions: [], contextFiles: [], verificationCommands: snapshot,
      managerMessageId: 'manager', managerPayloadHash: 'b'.repeat(64), executionScope: { branch: 'agent/fixture', worktree, allowedPaths: ['.'], forbiddenPaths: ['.git'] } });
    repo.createExecutionAuthorization({ id: 'AUTH', project_id: 'P', task_id: 'T', attempt_id: null, task_revision: 0,
      base_sha: 'a'.repeat(40), repository_head_sha: 'a'.repeat(40), manager_message_id: 'manager', manager_payload_hash: 'b'.repeat(64),
      routing_decision_id: 'fixture-route', selected_resource_id: resource.id, selected_provider_id: resource.provider_id,
      instruction_payload_hash: computePayloadHash(payload), context_manifest_hash: computeSha256('[]'),
      canonical_instructions_json: '[]', context_files_json: '[]', canonical_payload_json: JSON.stringify(payload),
      status: 'AUTHORIZED', created_at: new Date().toISOString(), dispatched_at: null });
    return payload;
  }

  function sealed(snapshot: CanonicalExecutionPayload['verificationCommands']) {
    const commands = canonicalJsonStringify(snapshot);
    return { adjudication_id: 'ADJ', lifecycle_version: 1, verification_execution_id: crypto.randomUUID(), authorization_id: 'AUTH',
      project_id: 'P', task_id: 'T', attempt_id: 'attempt', assignment_id: 'assignment', repo_path: root,
      verification_commands_json: commands, verification_commands_hash: computeSha256(commands),
      workspace_snapshot_before_json: '{}', workspace_snapshot_before_hash: computeSha256('{}'),
      policy: { timeout_ms: 10000, max_stdout_bytes: 4096, max_stderr_bytes: 4096, allowed_env_keys: ['AF_CAPABILITY_SENTINEL'] } };
  }

  it('preserves capability identity in canonical snapshots and runs configured/frozen verification only while active', async () => {
    const { command, snapshot, verification } = await configured();
    const payload = authorize(snapshot);
    expect(payload.verificationCommands.TEST?.capability).toEqual(command.capability);
    const configuredRun = await verification.runTests('P', 'T', null, root);
    expect(configuredRun.exit_code).toBe(0);
    const frozen = { ...snapshot.TEST!, timeout_ms: 10000, authorization_id: 'AUTH' };
    expect((await verification.runTestsWithFrozenCommand('P', 'T', null, root, frozen)).exit_code).toBe(0);
    new VerificationCapabilityService(repo).revoke(command.capability);
    expect((await verification.runTests('P', 'T', null, root)).exit_code).not.toBe(0);
    expect((await verification.runTestsWithFrozenCommand('P', 'T', null, root, frozen)).exit_code).not.toBe(0);
  });

  it('executes sealed verification with a live durable authorization and rejects recomputed snapshots after revocation or command substitution', async () => {
    const { command, snapshot, verification } = await configured();
    authorize(snapshot);
    const original = sealed(snapshot);
    const observed = await verification.executeSealedVerification(original);
    expect(observed, JSON.stringify(observed)).toMatchObject({ outcome: 'SUCCESS', process_start: 'STARTED_PROVEN' });
    const other = await approveFixtureCommand(repo, 'P', ['--help']);
    expect(await verification.executeSealedVerification(sealed({ ...snapshot, TEST: { ...other, timeout_ms: 120000 } })))
      .toMatchObject({ outcome: 'COMMAND_POLICY_REJECTED', process_start: 'NOT_STARTED_PROVEN' });
    new VerificationCapabilityService(repo).revoke(command.capability);
    expect(await verification.executeSealedVerification(original)).toMatchObject({ outcome: 'COMMAND_POLICY_REJECTED', process_start: 'NOT_STARTED_PROVEN' });
  });

  it.each(['active', 'revoked'] as const)('settles manual validation with the captured %s grant after the final Git await', async (state) => {
    const { command, verification } = await configured();
    // Isolate only Git observations; verification uses the real child runner.
    vi.spyOn(GitService, 'getStatus').mockResolvedValue({ status: 'SUCCESS', branch: 'main', isClean: true,
      modifiedFiles: [], untrackedFiles: [], aheadCount: 0, behindCount: 0 });
    vi.spyOn(GitService, 'getDiff').mockResolvedValue({ status: 'SUCCESS', diffStat: '', diffContent: '',
      filesChanged: [], insertions: 0, deletions: 0 });
    let headReads = 0;
    vi.spyOn(GitService, 'getHeadSha').mockImplementation(async () => {
      if (++headReads === 2 && state === 'revoked') new VerificationCapabilityService(repo).revoke(command.capability);
      return { status: 'SUCCESS', sha: 'a'.repeat(40) };
    });
    const tasks = new TaskService(repo, new EventService(repo), verification, verification.getArtifactStore());
    const result = await tasks.executeValidationFlow('T');
    expect(result.testRun?.exit_code).toBe(0);
    expect(repo.getLatestTestRun('T')?.exit_code).toBe(0);
    expect(repo.getProcessRunsByTask('T')[0]).toMatchObject({ status: 'COMPLETED', exit_code: 0 });
    if (state === 'active') {
      expect(result).toMatchObject({ success: true, finalTaskState: 'REVIEW_READY' });
    } else {
      expect(result).toMatchObject({ success: false, error: 'COMMAND_POLICY_REJECTED' });
      expect(repo.getTask('T')?.state).not.toBe('REVIEW_READY');
      const events = repo.getEvents('P', 100);
      expect(events.some((event) => event.type === 'VERIFICATION_PASSED')).toBe(false);
      expect(events.find((event) => event.type === 'VERIFICATION_FAILED')?.structured_payload).toMatchObject({ failureCode: 'COMMAND_POLICY_REJECTED' });
    }
  });

  it('refuses unapproved configured interpreters and sealed snapshots without durable authorization', async () => {
    repo.setProjectVerificationCommands('P', { TEST: { executable: 'node', args: ['--version'] } });
    const verification = new VerificationService(repo, new ArtifactStore(path.join(root, 'artifacts')));
    expect((await verification.runTests('P', 'T', null, root)).exit_code).not.toBe(0);
    const { snapshot } = await configured();
    expect(await verification.executeSealedVerification(sealed(snapshot))).toMatchObject({ outcome: 'COMMAND_POLICY_REJECTED', process_start: 'NOT_STARTED_PROVEN' });
  });

  it('does not accept a successful child result after its owner grant was withdrawn', async () => {
    const { command, snapshot, verification } = await configured();
    authorize(snapshot);
    verification.setProcessRunner({ execute: async (options) => {
      const observed = await ProcessRunner.execute(options);
      new VerificationCapabilityService(repo).revoke(command.capability);
      return observed;
    } });
    expect(await verification.executeSealedVerification(sealed(snapshot))).toMatchObject({
      outcome: 'COMMAND_POLICY_REJECTED', exit_code: 0, process_start: 'STARTED_PROVEN',
    });
  });

  it('rejects a script parent junction/symlink introduced after approval, including identical replacement contents', async () => {
    const scripts = path.join(root, 'scripts');
    const replacement = path.join(root, 'replacement');
    fs.mkdirSync(scripts);
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(scripts, 'verify.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(replacement, 'verify.js'), 'process.exit(0);');
    const { payload, boundary } = await approve(['scripts/verify.js']);
    fs.renameSync(scripts, path.join(root, 'original-scripts'));
    fs.symlinkSync(replacement, scripts, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, verificationBoundary: boundary }))
      .toMatchObject({ processStart: 'NOT_STARTED_PROVEN', pid: null, errorCode: 'PROCESS_LAUNCH_FAILED' });
  });

  it('does not accept a plain worktree path as authority and fences authorization invalidation at spawn', async () => {
    const { command, snapshot } = await configured();
    const worktree = path.join(root, 'owned-worktree');
    fs.mkdirSync(worktree);
    initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: worktree, stdio: 'ignore', windowsHide: true });
    const capabilities = new VerificationCapabilityService(repo);
    expect(() => capabilities.validate(command.capability, 'P', command.executable, command.args, worktree, worktree)).toThrow('CAPABILITY_BINDING_MISMATCH');
    authorize(snapshot, worktree);
    const boundary = capabilities.createProcessBoundary(command.capability, 'P', command.executable, command.args, worktree, 'AUTH');
    repo.invalidateExecutionAuthorization('AUTH');
    expect(await ProcessRunner.execute({ ...command, cwd: worktree, timeoutMs: 10000, verificationBoundary: boundary }))
      .toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
  });

  it.each(['content', 'identity'] as const)('fences %s drift of the actual absolute script when verification uses an authorized worktree', async (drift) => {
    const script = path.join(root, 'verify.js');
    const source = 'process.stdout.write("approved");';
    fs.writeFileSync(script, source);
    const worktree = path.join(root, 'owned-worktree');
    fs.mkdirSync(worktree);
    initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: worktree, stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(path.join(worktree, 'verify.js'), source);
    const command = await approveFixtureCommand(repo, 'P', [script]);
    const snapshot = { TEST: { ...command, timeout_ms: 10000 }, LINT: null, BUILD: null };
    authorize(snapshot, worktree);
    const capabilities = new VerificationCapabilityService(repo);
    const boundary = capabilities.createProcessBoundary(command.capability, 'P', command.executable, command.args, worktree, 'AUTH');
    expect(await ProcessRunner.execute({ ...command, cwd: worktree, timeoutMs: 10000, verificationBoundary: boundary }))
      .toMatchObject({ exitCode: 0, stdout: 'approved', processStart: 'STARTED_PROVEN' });
    if (drift === 'identity') fs.renameSync(script, path.join(root, 'old-verify.js'));
    fs.writeFileSync(script, drift === 'identity' ? source : 'process.stdout.write("changed");');
    expect(await ProcessRunner.execute({ ...command, cwd: worktree, timeoutMs: 10000, verificationBoundary: boundary }))
      .toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
  });

  it('checks the actual relative script in the authorized worktree after the original script changes', async () => {
    fs.writeFileSync(path.join(root, 'verify.js'), 'process.stdout.write("approved");');
    const worktree = path.join(root, 'owned-worktree');
    fs.mkdirSync(worktree);
    initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: worktree, stdio: 'ignore', windowsHide: true });
    fs.copyFileSync(path.join(root, 'verify.js'), path.join(worktree, 'verify.js'));
    const command = await approveFixtureCommand(repo, 'P', ['verify.js']);
    authorize({ TEST: { ...command, timeout_ms: 10000 }, LINT: null, BUILD: null }, worktree);
    fs.writeFileSync(path.join(root, 'verify.js'), 'process.stdout.write("changed");');
    const boundary = new VerificationCapabilityService(repo).createProcessBoundary(command.capability, 'P', command.executable, command.args, worktree, 'AUTH');
    expect(await ProcessRunner.execute({ ...command, cwd: worktree, timeoutMs: 10000, verificationBoundary: boundary }))
      .toMatchObject({ exitCode: 0, stdout: 'approved', processStart: 'STARTED_PROVEN' });
  });

  it('executes Supervisor evidence tests only with the exact frozen capability boundary', async () => {
    const { command, snapshot } = await configured();
    const payload = authorize(snapshot);
    const adapter = new ProductTaskAutonomyAdapter({ repo, maxWorkers: 1, artifactStore: new ArtifactStore(path.join(root, 'artifacts')) });
    const authority = { task: repo.getTask('T')!, authorization: repo.getExecutionAuthorization('AUTH')!, assignment: {} as any };
    const order = WorkOrderSchema.parse({ protocol_version: 'workorder.v1', task_id: 'T', issue_number: null, worker_id: 'fixture',
      objective: 'Bound verification', base_sha: 'a'.repeat(40), branch: payload.executionScope!.branch, worktree: root,
      dependencies: [], allowed_paths: ['.'], forbidden_paths: ['.git'], acceptance_criteria: ['Exact grant required'],
      required_tests: [renderCommand(snapshot.TEST!)], context_files: [], constraints: [], attempt: 1, lease_epoch: 1 });
    const actualTestRuns: string[] = [];
    const collector = new EvidenceCollector({ execute: async (options) => {
      // Git observations are isolated here; the verification child is real.
      if (options.executable === 'git') return { exitCode: 0, stdout: options.args[0] === 'rev-parse' ? 'a'.repeat(40) : '', stderr: '', durationMs: 0 };
      actualTestRuns.push(options.executable);
      return ProcessRunner.execute(options);
    } });
    expect((await collector.collect(order, order.required_tests)).tests[0]).toMatchObject({ exitCode: -1, stderr: 'OWNER_APPROVAL_REQUIRED' });
    expect(actualTestRuns).toEqual([]);
    const invocations = adapter.createVerificationInvocations(authority, order);
    expect((await collector.collect(order, order.required_tests, invocations)).tests[0].exitCode).toBe(0);
    expect(() => adapter.createVerificationInvocations(authority, { ...order, required_tests: ['npm exec replaced'] })).toThrow('VERIFICATION_COMMAND_SNAPSHOT_MISMATCH');
    new VerificationCapabilityService(repo).revoke(command.capability);
    expect((await collector.collect(order, order.required_tests, invocations)).tests[0].exitCode).not.toBe(0);
    expect(() => adapter.createVerificationInvocations(authority, order)).toThrow('CAPABILITY_REVOKED');
  });

  it('starts the exact approved executable with the boundary environment', async () => {
    const script = path.join(root, 'environment.js');
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify({value:process.env.AF_CAPABILITY_SENTINEL??null,profile:process.env.USERPROFILE??null,home:process.env.HOME??null,path:process.env.PATH}));");
    const { payload, boundary } = await approve(['environment.js']);
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000,
      verificationBoundary: boundary, env: { AF_CAPABILITY_SENTINEL: 'fixture-value-must-not-inherit' }, allowedEnvKeys: ['AF_CAPABILITY_SENTINEL'] });
    expect(result.processStart).toBe('STARTED_PROVEN');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ value: null, profile: '', home: '', path: boundary.environment.PATH });
    expect(boundary.environment).not.toHaveProperty('NODE_OPTIONS');
  });

  it.runIf(process.platform === 'win32')('holds the selected native root through an actual running verification child and releases it only after exit', async () => {
    const started = path.join(root, 'child-started');
    const release = path.join(root, 'release-child');
    fs.writeFileSync(path.join(root, 'held-child.js'), "const fs=require('fs'),path=require('path');fs.writeFileSync(path.join(__dirname,'child-started'),'running');const deadline=setTimeout(()=>process.exit(3),10000);const poll=setInterval(()=>{if(fs.existsSync(path.join(__dirname,'release-child'))){clearInterval(poll);clearTimeout(deadline);process.exit(0)}},20);");
    const { payload, boundary } = await approve(['held-child.js']);
    const execution = ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 15000, verificationBoundary: boundary });
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fs.readFileSync(started, 'utf8')).toBe('running');
      let renamed = false;
      try { fs.renameSync(root, root + '-changed'); renamed = true; } catch {}
      if (renamed) fs.renameSync(root + '-changed', root);
      expect(renamed).toBe(false);
      expect(() => fs.renameSync(path.join(root, '.git'), path.join(root, '.git-changed'))).toThrow();
    } finally {
      fs.writeFileSync(release, 'finish');
      expect(await execution).toMatchObject({ exitCode: 0, processStart: 'STARTED_PROVEN', processTermination: 'PROCESS_TREE_TERMINATED_PROVEN' });
    }
    fs.renameSync(root, root + '-changed');
    fs.renameSync(root + '-changed', root);
  });

  it('refuses an unbound historical project before persisting RUNNING or spawning the actual process', async () => {
    database.prepare('DELETE FROM project_repository_identities WHERE project_id=?').run('P');
    expect(await ProcessRunner.execute({ executable: process.execPath, args: ['--version'], cwd: root, timeoutMs: 10000, repo, projectId: 'P', taskId: 'T' }))
      .toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', processTermination: 'NOT_APPLICABLE', errorCode: 'REPOSITORY_ROOT_UNBOUND' });
    expect(repo.getProcessRunsByTask('T')).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM project_repository_identities').get()).toEqual({ count: 0 });
  });

  it('resolves bare trusted Git from its standard installation and executes its approved physical identity', async () => {
    const payload = service.propose('P', 'git', ['--version'], root);
    const reference = await service.approve(payload, async () => true);
    const boundary = service.createProcessBoundary(reference, 'P', payload.executable.path, payload.args, root);
    expect(path.isAbsolute(payload.executable.path)).toBe(true);
    expect(path.basename(payload.executable.path).toLowerCase()).toMatch(/^git(?:\.exe)?$/);
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000,
      verificationBoundary: boundary });
    expect(result).toMatchObject({ exitCode: 0, processStart: 'STARTED_PROVEN' });
    expect(result.stdout).toMatch(/^git version /);
  });

  it('revalidates revocation immediately before spawn', async () => {
    const { payload, reference, boundary } = await approve(['--version']);
    service.revoke(reference);
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, verificationBoundary: boundary });
    expect(result).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects argv drift and a copied unissued boundary without starting a child', async () => {
    const { payload, boundary } = await approve(['--version']);
    const drift = await ProcessRunner.execute({ executable: payload.executable.path, args: ['--help'], cwd: root, timeoutMs: 10000, verificationBoundary: boundary });
    expect(drift).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
    const copied = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, verificationBoundary: { ...boundary } });
    expect(copied).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
  });

  it('rejects script mutation after boundary creation and preserves process start truth', async () => {
    const script = path.join(root, 'check.js');
    fs.writeFileSync(script, 'process.stdout.write("old");');
    const { payload, boundary } = await approve(['check.js']);
    fs.writeFileSync(script, 'process.stdout.write("changed");');
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, verificationBoundary: boundary });
    expect(result).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
    expect(result.stdout).toBe('');
  });

  it('rejects shell opt-in even with an issued boundary', async () => {
    const { payload, boundary } = await approve(['--version']);
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, allowShell: true, verificationBoundary: boundary });
    expect(result).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
  });
});
