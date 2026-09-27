import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { AutonomyStore } from '../core/autonomy/store';
import { AntigravityAdapter, CodexManagerAdapter } from '../core/autonomy/providers';
import { AutonomySupervisor } from '../core/autonomy/supervisor';
import { runDisposableSelfHostProof } from '../core/autonomy/selfHost';
import { ProcessRunner } from '../core/services/ProcessRunner';
import { SelfHostTaskSchema } from '../core/autonomy/contracts';
import { assertPathContained } from '../core/services/ArtifactStore';
import crypto from 'crypto';
import { GithubCiObserver } from '../core/autonomy/github';
import { loadOmniRouteEndpointFromEnvironment, ResponsesManagerEndpointTransport } from '../core/autonomy/responsesEndpoint';
import { ResponsesCoderEndpointTransport } from '../core/autonomy/responsesCoderEndpoint';

const controlRepo = process.env.AGENT_FORGE_CONTROL_REPO ?? process.cwd();
const worktreeRoot = process.env.AGENT_FORGE_WORKTREE_ROOT ?? path.resolve(controlRepo, '..', 'AI', 'Agent-Forge-Worktrees');
const runtimeRoot = process.env.AGENT_FORGE_RUNTIME_ROOT ?? path.resolve(controlRepo, '..', 'AI', 'Agent-Forge-Runtime');
const codexExecutable = process.env.CODEX_EXECUTABLE ?? (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : 'codex');

function run(command: string, args: string[], cwd = controlRepo, timeout = 30_000): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, shell: false });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return { ok: result.status === 0, stdout, stderr };
}

function redact(text: string): string {
  return text.replace(/(?:gh[pousr]_[A-Za-z0-9_\-]{20,})/g, '[REDACTED_SECRET]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED_SECRET]');
}

let failedChecks = 0;
function check(name: string, ok: boolean, details: string): void {
  if (!ok) failedChecks++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${details ? `: ${redact(details).split(/\r?\n/)[0]}` : ''}\n`);
}

async function doctor(): Promise<number> {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  check('control repo exists', fs.existsSync(controlRepo), controlRepo);
  const git = run('git', ['status', '--short', '--branch']); check('control repo Git state', git.ok, git.stderr || git.stdout);
  check('Node version', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  const npm = process.platform === 'win32' ? run('cmd.exe', ['/d', '/c', 'npm.cmd', '--version']) : run('npm', ['--version']);
  check('npm', npm.ok, npm.stdout || npm.stderr);
  const gitVersion = run('git', ['--version']); check('git', gitVersion.ok, gitVersion.stdout || gitVersion.stderr);
  const gh = run('gh', ['--version']); check('gh', gh.ok, gh.stdout || gh.stderr);
  const ghAuth = run('gh', ['auth', 'status']); check('GitHub auth', ghAuth.ok, ghAuth.ok ? 'authenticated' : 'credentials unavailable or expired');
  const codexVersion = run(codexExecutable, ['--version']); check('Codex executable', codexVersion.ok, codexVersion.stdout || codexVersion.stderr);
  const codexContract = await new CodexManagerAdapter({ executable: codexExecutable }).contract(controlRepo);
  const codexAnswer = codexContract.stdout.split(/\r?\n/).some((line) => { try { const event = JSON.parse(line); return event.item?.type === 'agent_message' && event.item.text?.trim() === 'CODEX_OK'; } catch { return false; } });
  check('Codex non-interactive contract', codexContract.status === 'SUCCESSFUL_PROCESS_EXIT' && codexAnswer, codexContract.status);
  const agy = new AntigravityAdapter({ timeoutMs: 60_000 });
  const agyVersion = await agy.version(); check('Antigravity executable', agyVersion.status === 'SUCCESSFUL_PROCESS_EXIT', agyVersion.stderr || agyVersion.stdout);
  const disposable = path.join(worktreeRoot, `doctor-${crypto.randomUUID()}`);
  assertPathContained(disposable, worktreeRoot);
  const created = run('git', ['worktree', 'add', '--detach', disposable, 'HEAD']);
  check('disposable worktree create', created.ok, created.ok ? disposable : created.stderr);
  if (created.ok) {
    try {
      const agyContract = await agy.contract(disposable);
      check('Antigravity non-interactive contract', agyContract.status === 'SUCCESSFUL_PROCESS_EXIT' && agyContract.stdout.trim() === 'AGY_OK', agyContract.status);
    } finally {
      const removed = run('git', ['worktree', 'remove', disposable]);
      check('disposable worktree remove', removed.ok, removed.ok ? 'clean worktree removed' : 'retained for inspection');
    }
  }
  for (const [name, root] of [['runtime root writable', runtimeRoot], ['worktree root writable', worktreeRoot]]) {
    const probe = path.join(root, `.doctor-${crypto.randomUUID()}`);
    try { fs.writeFileSync(probe, 'probe', { flag: 'wx' }); fs.unlinkSync(probe); check(name, true, root); }
    catch { check(name, false, root); }
  }
  try { const opened = AutonomyStore.open(runtimeRoot); opened.engine.close(); check('SQLite migrations', true, opened.dbPath); } catch (error) { check('SQLite migrations', false, String(error)); }
  const remote = run('git', ['remote', 'get-url', 'origin']); check('remote repository', remote.ok, remote.stdout || remote.stderr);
  process.stdout.write(`CONTROL_REPO=${controlRepo}\nWORKTREE_ROOT=${worktreeRoot}\nRUNTIME_ROOT=${runtimeRoot}\n`);
  return failedChecks === 0 ? 0 : 1;
}

async function doctorOmniRoute(): Promise<number> {
  const manager = loadOmniRouteEndpointFromEnvironment('MANAGER');
  const reviewer = loadOmniRouteEndpointFromEnvironment('REVIEWER');
  if (!manager || !reviewer) {
    check('OmniRoute configuration', false, 'Set AGENT_FORGE_OMNIROUTE_ENABLED=1, base URL, auth env reference, and role models');
    return 1;
  }
  check('OmniRoute configuration', true, 'external route and auth reference loaded');
  check('OmniRoute manager model', true, manager.model_or_route);
  check('OmniRoute reviewer model', true, reviewer.model_or_route);
  const transport = new ResponsesManagerEndpointTransport();
  const [managerContract, reviewerContract] = await Promise.all([
    transport.contract(manager),
    transport.contract(reviewer),
  ]);
  check('OmniRoute manager Responses contract', managerContract.compatible, managerContract.run.status);
  check('OmniRoute reviewer Responses contract', reviewerContract.compatible, reviewerContract.run.status);
  return managerContract.compatible && reviewerContract.compatible ? 0 : 1;
}

export async function doctorOmniRouteCoder(): Promise<number> {
  const coder = loadOmniRouteEndpointFromEnvironment('CODER');
  if (!coder) {
    check('OmniRoute coder configuration', false, 'Set AGENT_FORGE_OMNIROUTE_ENABLED=1, base URL, auth env reference, and AGENT_FORGE_CODER_MODEL');
    return 1;
  }
  check('OmniRoute coder configuration', true, 'external route and auth reference loaded');
  check('OmniRoute coder model', true, coder.model_or_route);
  const transport = new ResponsesCoderEndpointTransport();
  const coderContract = await transport.contract(coder);
  check('OmniRoute coder Responses contract', coderContract.compatible, coderContract.run.status);
  return coderContract.compatible ? 0 : 1;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const rawMaxWorkers = process.env.MAX_AGY_WORKERS !== undefined ? Number(process.env.MAX_AGY_WORKERS) : 1;
  if (!Number.isInteger(rawMaxWorkers) || rawMaxWorkers < 1 || rawMaxWorkers > 2) {
    process.stderr.write('CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS_BOUNDS: Autonomy CLI accepts only MAX_AGY_WORKERS integers from 1 through 2\n');
    return 1;
  }
  const command = argv[2] ?? 'status';
  if (command === 'doctor') return doctor();
  if (command === 'doctor-omniroute') return doctorOmniRoute();
  if (command === 'doctor-coder' || command === 'doctor-omniroute-coder') return doctorOmniRouteCoder();
  const effectiveControlRepo = process.env.AGENT_FORGE_CONTROL_REPO ?? controlRepo;
  const effectiveWorktreeRoot = process.env.AGENT_FORGE_WORKTREE_ROOT ?? path.resolve(effectiveControlRepo, '..', 'AI', 'Agent-Forge-Worktrees');
  const effectiveRuntimeRoot = process.env.AGENT_FORGE_RUNTIME_ROOT ?? path.resolve(effectiveControlRepo, '..', 'AI', 'Agent-Forge-Runtime');
  const store = AutonomyStore.open(effectiveRuntimeRoot);
  const supervisor = new AutonomySupervisor({ store: store.store, mode: command === 'shadow' ? 'SHADOW' : 'PILOT', runtimeRoot: effectiveRuntimeRoot, controlRepo: effectiveControlRepo, worktreeRoot: effectiveWorktreeRoot, maxWorkers: rawMaxWorkers });
  const ci = new GithubCiObserver(store.store, effectiveControlRepo, supervisor.managerPool);
  if (command === 'status') { process.stdout.write(`${JSON.stringify({ mode: supervisor.mode, maxWorkers: supervisor.maxWorkers, orders: supervisor.store.listAll(), activeSlots: supervisor.store.listActiveSlots(), runtimeRoot: effectiveRuntimeRoot, legacyInventory: supervisor.store.inventoryLegacyState() })}\n`); return 0; }
  if (command === 'inventory-legacy') { process.stdout.write(`${JSON.stringify(supervisor.store.inventoryLegacyState(), null, 2)}\n`); return 0; }
  if (command === 'stop') { store.store.requestStop(); process.stdout.write('Stop requested in durable state.\n'); return 0; }
  if (command === 'enqueue' || command === 'enqueue-authorized') {
    const file = path.resolve(argv[3] ?? '');
    assertPathContained(file, effectiveRuntimeRoot);
    const task = SelfHostTaskSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    store.store.getDatabase().transaction(() => {
      store.store.enqueue(task);
      if (command === 'enqueue-authorized') store.store.event(task.task_id, 'TASK_MANAGER_AUTHORIZED', { task, source: 'operator-manager', reviewRequired: true });
    })();
    process.stdout.write('Task enqueued in SQLite.\n'); return 0;
  }
  if (command === 'register-ci') {
    const file = path.resolve(argv[3] ?? '');
    assertPathContained(file, effectiveRuntimeRoot);
    const input = JSON.parse(fs.readFileSync(file, 'utf8')) as { task_id: string; work_order_id?: string | null; repository: string; pr_number: number; branch: string; expected_head_sha: string };
    const watch = ci.register({ taskId: input.task_id, workOrderId: input.work_order_id, repository: input.repository, prNumber: input.pr_number, branch: input.branch, expectedHeadSha: input.expected_head_sha });
    process.stdout.write(`${JSON.stringify(watch)}\n`); return 0;
  }
  if (command === 'observe') {
    const observations = await ci.observeDue();
    process.stdout.write(`${JSON.stringify(observations)}\n`); return 0;
  }
  const owner = store.store.acquireOwner();
  const cancellation = setInterval(() => { if (store.store.shouldStop()) void ProcessRunner.terminateAllProcesses(); }, 1000);
  try {
  supervisor.recover();
  if (command === 'recover') { process.stdout.write('Recovery completed; retained worktrees and fenced attempts remain in durable state.\n'); return 0; }
  if (command === 'pilot') {
    const proof = await runDisposableSelfHostProof({ controlRepo: effectiveControlRepo, worktreeRoot: effectiveWorktreeRoot, supervisor });
    process.stdout.write(`${JSON.stringify({ mode: supervisor.mode, accepted: proof.result.accepted ?? false, state: proof.result.state, verdict: proof.result.review?.verdict, error: proof.result.error, worktree: proof.worktree, branch: proof.branch, baseSha: proof.baseSha })}\n`);
    return proof.result.accepted ? 0 : 1;
  }
  if (command === 'shadow') { process.stdout.write(`${JSON.stringify({ mode: supervisor.mode, status: 'RECOVERY_ONLY', ready: supervisor.store.listReady().length })}\n`); return 0; }
  if (command === 'start') {
    const proven = store.store.getDatabase().prepare("SELECT id FROM autonomy_events WHERE event_type='LOCAL_ACCEPTED' LIMIT 1").get();
    if (!proven) throw new Error('PILOT_PROOF_REQUIRED');
    const workerDescription = supervisor.maxWorkers === 1 ? 'one worker' : 'two workers';
    process.stdout.write(`Agent Forge PILOT supervisor started (${workerDescription}; no push or merge).\n`);
    const pollIntervalMs = process.env.AGENT_FORGE_POLL_INTERVAL_MS !== undefined
      ? Number(process.env.AGENT_FORGE_POLL_INTERVAL_MS)
      : undefined;
    const queue = supervisor.createContinuousQueue({
      ci,
      controlRepo: effectiveControlRepo,
      worktreeRoot: effectiveWorktreeRoot,
      ...(pollIntervalMs !== undefined && !Number.isNaN(pollIntervalMs) ? { pollIntervalMs } : {}),
      onEvent: (type, payload) => {
        if (type === 'TASK_SETTLED') {
          process.stdout.write(`${JSON.stringify({ task: payload.task, accepted: payload.accepted, state: payload.state, publishedHead: payload.publishedHead })}\n`);
        } else if (type === 'TASK_BLOCKED') {
          process.stdout.write(`${payload.task}: BLOCKED\n`);
        } else if (type === 'CI_OBSERVATION') {
          process.stdout.write(`${JSON.stringify({ ci: payload.watch.pr_number, conclusion: payload.conclusion, headSha: payload.headSha, repairTaskId: payload.repairTaskId })}\n`);
        } else if (type === 'CI_RETRY_DEFERRED') {
          process.stdout.write(`CI observer retry deferred: ${redact(payload.error)}\n`);
        }
      },
    });
    return await queue.run();
  }
  process.stderr.write(`Unknown autonomy command: ${command}\n`); return 2;
  } finally { clearInterval(cancellation); store.store.releaseOwner(owner); store.engine.close(); }
}

const isDirectCliExecution = (): boolean => {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return false;
  }
  const entry = process.argv[1];
  return Boolean(entry && /autonomyCli(\.[cm]?[jt]s)?$/i.test(entry));
};

if (isDirectCliExecution()) {
  main().then((code) => process.exit(code)).catch((error) => { process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`); process.exit(1); });
}
