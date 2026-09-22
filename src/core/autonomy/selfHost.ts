import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { CodexManagerAdapter } from './providers';
import { AutonomousTaskSpec, SelfHostTask, createWorkOrder } from './contracts';
import { AutonomySupervisor, SupervisorRunResult } from './supervisor';
import { GitWorktreeService } from '../services/GitWorktreeService';
import { ManagerProviderPool } from './managerPool';

export interface SelfHostProofOptions {
  controlRepo: string;
  worktreeRoot: string;
  supervisor: AutonomySupervisor;
  manager?: CodexManagerAdapter;
  managerPool?: ManagerProviderPool;
  task?: SelfHostTask;
}

export interface SelfHostProofResult {
  result: SupervisorRunResult;
  worktree: string;
  branch: string;
  baseSha: string;
  cleanupRequired: boolean;
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  return { ok: result.status === 0, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '').trim() };
}

export async function runDisposableSelfHostProof(options: SelfHostProofOptions): Promise<SelfHostProofResult> {
  const { controlRepo, worktreeRoot, supervisor } = options;
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const head = git(['rev-parse', '--verify', options.task?.base_sha ?? 'HEAD'], controlRepo);
  if (!head.ok || !/^[0-9a-f]{40}$/i.test(head.stdout)) throw new Error(`SELF_HOST_BASE_SHA_FAILED: ${head.stderr || head.stdout}`);
  const id = crypto.randomUUID().slice(0, 8);
  const taskId = options.task?.task_id ?? `SELF-HOST-${id}`;
  const branch = `agent/agy-01/${taskId.toLowerCase()}-${id}`;
  const gitExecutable = (process.env.Path ?? process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git')).find((file) => fs.existsSync(file));
  if (!gitExecutable) throw new Error('GIT_EXECUTABLE_NOT_FOUND');
  const worktrees = new GitWorktreeService({ gitExecutable, repositoryRoot: controlRepo, managedRoot: worktreeRoot });
  const tuple = { projectId: 'AGENT-FORGE', taskId, assignmentId: id, workerSlotId: 'agy-01', baseSha: head.stdout };
  supervisor.store.event(tuple.taskId, 'WORKTREE_INTENT', tuple);
  const added = await worktrees.createWorktree(tuple);
  if (added.status !== 'CREATED') throw new Error(`SELF_HOST_WORKTREE_CREATE_FAILED: ${added.error}`);
  const worktree = added.worktreePath;
  supervisor.store.event(tuple.taskId, 'WORKTREE_CREATED', { worktree, branch, baseSha: head.stdout });
  const branchResult = git(['switch', '-c', branch], worktree);
  if (!branchResult.ok) throw new Error(`SELF_HOST_BRANCH_CREATE_FAILED: ${branchResult.stderr || branchResult.stdout}`);

  const managerPool = options.managerPool ?? (options.manager ? ManagerProviderPool.fromPrimary(supervisor.store, options.manager) : supervisor.managerPool);
  const seed: AutonomousTaskSpec = {
    taskId,
    issueNumber: null,
    workerId: 'agy-01',
    objective: options.task?.objective ?? 'Using the file edit tool, create .agentforge-pilot-proof.txt containing SELF_HOST_PROOF_OK followed by exactly one LF newline. Do not run terminal commands. The supervisor independently runs the required test.',
    baseSha: head.stdout,
    branch,
    worktree,
    allowedPaths: options.task?.allowed_paths ?? ['.agentforge-pilot-proof.txt'],
    forbiddenPaths: ['.git', controlRepo, 'main'],
    acceptanceCriteria: options.task?.acceptance_criteria ?? ['.agentforge-pilot-proof.txt contains exactly the UTF-8 bytes SELF_HOST_PROOF_OK followed by one LF newline'],
    requiredTests: options.task?.required_tests ?? ['agentforge:proof'],
    contextFiles: options.task?.context_files ?? [],
    constraints: ['Do not push or merge.', 'Do not modify files outside the allowed path.', ...(options.task?.constraints ?? [])],
  };
  // An operator/manager may authorize the immutable task seed before dispatch.
  // This supplies planning only: tests and the independent review still apply.
  const authorized = supervisor.store.getDatabase().prepare("SELECT id FROM autonomy_events WHERE work_order_id=? AND event_type='TASK_MANAGER_AUTHORIZED'").get(taskId);
  const planned = authorized ? {
    workOrder: createWorkOrder(seed),
    run: { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: '', stdout: '', stderr: '', durationMs: 0, error: undefined },
    resource_id: 'authorized',
    attempts: [],
  } : await managerPool.plan({
    task_id: seed.taskId, worker_id: seed.workerId, objective: seed.objective,
    base_sha: seed.baseSha, branch: seed.branch, worktree: seed.worktree,
    acceptance_criteria: seed.acceptanceCriteria,
    required_tests: seed.requiredTests,
    allowed_paths: seed.allowedPaths,
    forbidden_paths: seed.forbiddenPaths,
    constraints: seed.constraints,
  });
  supervisor.store.event(seed.taskId, 'MANAGER_PLAN', planned);
  if (!planned.workOrder) throw new Error(`SELF_HOST_MANAGER_PLAN_FAILED: ${planned.run.error || planned.run.stderr}`);
  const result = await supervisor.run({
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
  return { result, worktree, branch, baseSha: head.stdout, cleanupRequired: true };
}
