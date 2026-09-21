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

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'status';
  if (command === 'doctor') return doctor();
  const store = AutonomyStore.open(runtimeRoot);
  const supervisor = new AutonomySupervisor({ store: store.store, mode: command === 'shadow' ? 'SHADOW' : 'PILOT', runtimeRoot, controlRepo, worktreeRoot });
  const ci = new GithubCiObserver(store.store, controlRepo, supervisor.managerPool);
  if (command === 'status') { process.stdout.write(`${JSON.stringify({ mode: supervisor.mode, maxWorkers: supervisor.maxWorkers, orders: supervisor.store.listAll(), activeSlots: supervisor.store.listActiveSlots(), runtimeRoot, legacyInventory: supervisor.store.inventoryLegacyState() })}\n`); return 0; }
  if (command === 'inventory-legacy') { process.stdout.write(`${JSON.stringify(supervisor.store.inventoryLegacyState(), null, 2)}\n`); return 0; }
  if (command === 'stop') { store.store.requestStop(); process.stdout.write('Stop requested in durable state.\n'); return 0; }
  if (command === 'enqueue' || command === 'enqueue-authorized') {
    const file = path.resolve(process.argv[3] ?? '');
    assertPathContained(file, runtimeRoot);
    const task = SelfHostTaskSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    store.store.getDatabase().transaction(() => {
      store.store.enqueue(task);
      if (command === 'enqueue-authorized') store.store.event(task.task_id, 'TASK_MANAGER_AUTHORIZED', { task, source: 'operator-manager', reviewRequired: true });
    })();
    process.stdout.write('Task enqueued in SQLite.\n'); return 0;
  }
  if (command === 'register-ci') {
    const file = path.resolve(process.argv[3] ?? '');
    assertPathContained(file, runtimeRoot);
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
    const proof = await runDisposableSelfHostProof({ controlRepo, worktreeRoot, supervisor });
    process.stdout.write(`${JSON.stringify({ mode: supervisor.mode, accepted: proof.result.accepted ?? false, state: proof.result.state, verdict: proof.result.review?.verdict, error: proof.result.error, worktree: proof.worktree, branch: proof.branch, baseSha: proof.baseSha })}\n`);
    return proof.result.accepted ? 0 : 1;
  }
  if (command === 'shadow') { process.stdout.write(`${JSON.stringify({ mode: supervisor.mode, status: 'RECOVERY_ONLY', ready: supervisor.store.listReady().length })}\n`); return 0; }
  if (command === 'start') {
    const proven = store.store.getDatabase().prepare("SELECT id FROM autonomy_events WHERE event_type='LOCAL_ACCEPTED' LIMIT 1").get();
    if (!proven) throw new Error('PILOT_PROOF_REQUIRED');
    process.stdout.write('Agent Forge PILOT supervisor started (one worker; no push or merge).\n');
    let activeTask: Promise<void> | null = null;
    while (!store.store.shouldStop()) {
      const task = activeTask ? null : store.store.claimNext();
      if (task) activeTask = (async () => { try {
        const result = await runDisposableSelfHostProof({ controlRepo, worktreeRoot, supervisor, task });
        let publishedHead: string | null = null;
        if (result.result.accepted) {
          publishedHead = await ci.publishAcceptedRepair(task.task_id, result.worktree, result.branch);
        }
        store.store.event(task.task_id, 'TASK_SETTLED', { accepted: result.result.accepted ?? false, state: result.result.state, worktree: result.worktree, branch: result.branch, error: result.result.error });
        process.stdout.write(`${JSON.stringify({ task: task.task_id, accepted: result.result.accepted ?? false, state: result.result.state, publishedHead })}\n`);
      } catch (error) {
        store.store.event(task.task_id, 'TASK_BLOCKED', { error: redact(String(error)) });
        process.stdout.write(`${task.task_id}: BLOCKED\n`);
      } })().finally(() => { activeTask = null; });
      try {
        for (const observation of await ci.observeDue()) process.stdout.write(`${JSON.stringify({ ci: observation.watch.pr_number, conclusion: observation.conclusion, headSha: observation.headSha, repairTaskId: observation.repairTaskId })}\n`);
      } catch (error) {
        process.stdout.write(`CI observer retry deferred: ${redact(String(error))}\n`);
      }
      if (!task) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await activeTask;
    return 0;
  }
  process.stderr.write(`Unknown autonomy command: ${command}\n`); return 2;
  } finally { clearInterval(cancellation); store.store.releaseOwner(owner); store.engine.close(); }
}

main().then((code) => process.exit(code)).catch((error) => { process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`); process.exit(1); });
