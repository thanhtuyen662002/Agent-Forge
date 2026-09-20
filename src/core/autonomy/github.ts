import path from 'path';
import { ManagerReview, SelfHostTask, WorkOrder, sanitizeAutonomyText } from './contracts';
import { AutonomyCiWatch, AutonomyStore } from './store';
import { CodexManagerAdapter, ManagerEvidence, ProviderRun } from './providers';
import { ProcessRunner } from '../services/ProcessRunner';
import { Repository } from '../database/repositories';

export type CiConclusion = 'PENDING' | 'SUCCESS' | 'FAILURE';

export interface GithubCheck {
  name?: string;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  databaseId?: number | null;
}

export interface GithubPullRequest {
  number: number;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  statusCheckRollup?: GithubCheck[];
}

export interface CiObservationResult {
  watch: AutonomyCiWatch;
  conclusion: CiConclusion;
  headSha?: string;
  evidence?: string;
  review?: ManagerReview;
  managerRun?: ProviderRun;
  repairTaskId?: string;
}

interface CommandResult { status: number | null; stdout: string; stderr: string; }
type Command = (executable: string, args: string[], cwd: string) => Promise<CommandResult>;

const successConclusions = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'PASS']);
const failureConclusions = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

async function defaultCommand(repository: Repository, executable: string, args: string[], cwd: string): Promise<CommandResult> {
  const result = await ProcessRunner.execute({ executable, args, cwd, timeoutMs: 60_000, allowShell: false, stdin: '', repo: repository });
  return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr || result.error?.message || '' };
}

function parseJson<T>(output: string): T {
  try { return JSON.parse(output) as T; } catch { throw new Error('GITHUB_CONTRACT_INVALID: gh returned non-JSON output'); }
}

function nextPoll(attempt: number): string {
  const seconds = Math.min(300, 30 * (2 ** Math.min(attempt, 4)));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function classifyChecks(checks: GithubCheck[] | undefined): CiConclusion {
  if (!checks?.length) return 'PENDING';
  if (checks.some((check) => check.status !== 'COMPLETED' && check.conclusion !== 'SUCCESS')) return 'PENDING';
  if (checks.some((check) => failureConclusions.has(String(check.conclusion ?? '').toUpperCase()))) return 'FAILURE';
  return checks.every((check) => successConclusions.has(String(check.conclusion ?? '').toUpperCase())) ? 'SUCCESS' : 'PENDING';
}

function runId(url: string | null | undefined): string | null {
  const match = url?.match(/\/actions\/runs\/(\d+)/);
  return match?.[1] ?? null;
}

export class GithubCiObserver {
  constructor(
    private readonly store: AutonomyStore,
    private readonly controlRepo: string,
    private readonly manager?: CodexManagerAdapter,
    command?: Command,
  ) {
    this.command = command ?? ((executable, args, cwd) => defaultCommand(new Repository(store.getDatabase()), executable, args, cwd));
  }

  private readonly command: Command;

  register(input: { taskId: string; workOrderId?: string | null; repository: string; prNumber: number; branch: string; expectedHeadSha: string }): AutonomyCiWatch {
    if (!/^[0-9a-f]{40}$/i.test(input.expectedHeadSha)) throw new Error('CONTRACT_INVALID: expected PR head must be a Git SHA');
    return this.store.registerCiWatch(input);
  }

  async observeDue(): Promise<CiObservationResult[]> {
    const results: CiObservationResult[] = [];
    for (const watch of this.store.listDueCiWatches()) results.push(await this.observe(watch));
    return results;
  }

  async observe(watch: AutonomyCiWatch): Promise<CiObservationResult> {
    const prResult = await this.command('gh', ['pr', 'view', String(watch.pr_number), '--repo', watch.repository, '--json', 'number,isDraft,headRefName,headRefOid,statusCheckRollup'], this.controlRepo);
    if (prResult.status !== 0) throw new Error(`GITHUB_PR_OBSERVE_FAILED: ${sanitizeAutonomyText(prResult.stderr || prResult.stdout)}`);
    const pr = parseJson<GithubPullRequest>(prResult.stdout);
    if (!pr.isDraft || pr.headRefName !== watch.branch) {
      this.store.updateCiWatch(watch.id, { state: 'BLOCKED', last_observed_at: new Date().toISOString() });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_CLAIM_REJECTED', { reason: 'DRAFT_OR_BRANCH_MISMATCH', pr });
      return { watch, conclusion: 'FAILURE', headSha: pr.headRefOid };
    }
    const headSha = pr.headRefOid.toLowerCase();
    try { this.store.reconcileExternalClaim('github-pr', `${watch.repository}#${watch.pr_number}`, watch.work_order_id ?? watch.task_id, headSha, 'OBSERVED'); }
    catch (error) {
      this.store.updateCiWatch(watch.id, { state: 'BLOCKED', last_observed_at: new Date().toISOString() });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_CLAIM_REJECTED', { reason: String(error), headSha });
      throw error;
    }
    if (headSha !== watch.expected_head_sha.toLowerCase()) {
      this.store.updateCiWatch(watch.id, { state: 'BLOCKED', last_observed_at: new Date().toISOString() });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_HEAD_MISMATCH', { expected: watch.expected_head_sha, observed: headSha });
      return { watch, conclusion: 'FAILURE', headSha };
    }
    const conclusion = classifyChecks(pr.statusCheckRollup);
    const observedAt = new Date().toISOString();
    if (conclusion === 'PENDING') {
      this.store.updateCiWatch(watch.id, { state: 'CI_WAIT', poll_attempt: watch.poll_attempt + 1, next_poll_at: nextPoll(watch.poll_attempt), last_observed_at: observedAt });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_OBSERVED', { conclusion, headSha, checks: pr.statusCheckRollup ?? [] });
      return { watch, conclusion, headSha };
    }
    if (conclusion === 'SUCCESS') {
      this.store.updateCiWatch(watch.id, { state: 'CI_SUCCESS', repair_task_id: null, last_observed_at: observedAt });
      const row = watch.work_order_id ? this.store.getWorkOrder(watch.work_order_id) : null;
      if (row && ['CI_WAIT', 'PR_OPEN'].includes(row.state)) this.store.updateState(row.id, 'MERGE_READY', row.lease_epoch);
      if (watch.repair_task_id) {
        const repair = this.store.findLatestWorkOrderByTask(watch.repair_task_id);
        if (repair && ['CI_WAIT', 'PR_OPEN'].includes(repair.state)) this.store.updateState(repair.id, 'MERGE_READY', repair.lease_epoch);
      }
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_SUCCESS', { headSha, checks: pr.statusCheckRollup ?? [] });
      return { watch, conclusion, headSha };
    }
    const evidence = await this.failureEvidence(watch.repository, pr.statusCheckRollup ?? []);
    this.store.updateCiWatch(watch.id, { state: 'CI_FAILURE', poll_attempt: watch.poll_attempt + 1, next_poll_at: nextPoll(watch.poll_attempt), last_observed_at: observedAt });
    this.store.event(watch.work_order_id ?? watch.task_id, 'CI_FAILURE_EVIDENCE', { headSha, evidence, checks: pr.statusCheckRollup ?? [] });
    const row = watch.work_order_id ? this.store.getWorkOrder(watch.work_order_id) : null;
    if (!row || !this.manager) return { watch, conclusion, headSha, evidence };
    const reviewResult = await this.manager.review({ workOrder: JSON.parse(row.payload_json) as WorkOrder, evidence: JSON.stringify({ pull_request: pr, headSha, ci_evidence: evidence }) } satisfies ManagerEvidence);
    this.store.recordRun(row.id, 'codex-ci-review', reviewResult.run);
    if (!reviewResult.review) {
      this.store.event(row.id, 'CI_DIAGNOSIS_BLOCKED', { status: reviewResult.run.status, error: reviewResult.run.error, stderr: reviewResult.run.stderr });
      return { watch, conclusion, headSha, evidence, managerRun: reviewResult.run };
    }
    this.store.recordReview(row.id, reviewResult.review);
    if (reviewResult.review.verdict !== 'REPAIR') {
      this.store.updateCiWatch(watch.id, { state: reviewResult.review.verdict === 'BLOCKED' ? 'BLOCKED' : 'CI_FAILURE' });
      this.store.event(row.id, 'CI_DIAGNOSIS_REJECTED', { verdict: reviewResult.review.verdict });
      return { watch, conclusion, headSha, evidence, review: reviewResult.review, managerRun: reviewResult.run };
    }
    if (['CI_WAIT', 'PR_OPEN'].includes(row.state)) this.store.updateState(row.id, 'REPAIR', row.lease_epoch);
    const repairTaskId = `${row.task_id}-CI-${headSha.slice(0, 8)}`.slice(0, 80);
    const repairTask: SelfHostTask = {
      task_id: repairTaskId, objective: `Repair CI failure for ${watch.repository}#${watch.pr_number}. Inspect the persisted CI evidence and implement the manager's required actions.`,
      base_sha: headSha, allowed_paths: JSON.parse(row.payload_json).allowed_paths, required_tests: JSON.parse(row.payload_json).required_tests,
      acceptance_criteria: JSON.parse(row.payload_json).acceptance_criteria, context_files: JSON.parse(row.payload_json).context_files,
      constraints: [...JSON.parse(row.payload_json).constraints, `CI evidence: ${evidence}`, `Manager findings: ${JSON.stringify(reviewResult.review.findings)}`, `Required actions: ${JSON.stringify(reviewResult.review.required_actions)}`],
    };
    this.store.enqueue(repairTask);
    this.store.updateCiWatch(watch.id, { state: 'REPAIR_QUEUED', repair_task_id: repairTaskId });
    this.store.event(row.id, 'CI_REPAIR_QUEUED', { repairTaskId, headSha });
    return { watch, conclusion, headSha, evidence, review: reviewResult.review, managerRun: reviewResult.run, repairTaskId };
  }

  async failureEvidence(repository: string, checks: GithubCheck[]): Promise<string> {
    const failed = checks.filter((check) => failureConclusions.has(String(check.conclusion ?? '').toUpperCase()));
    const chunks: string[] = [];
    for (const check of failed) {
      const id = check.databaseId?.toString() ?? runId(check.detailsUrl);
      if (!id) { chunks.push(`${check.name ?? 'unknown'}: ${check.detailsUrl ?? 'no details URL'}`); continue; }
      const result = await this.command('gh', ['run', 'view', id, '--repo', repository, '--log-failed'], this.controlRepo);
      chunks.push(`${check.name ?? id}\n${sanitizeAutonomyText(result.stdout || result.stderr)}`);
    }
    return sanitizeAutonomyText(chunks.join('\n\n'));
  }

  async publishAcceptedRepair(taskId: string, worktree: string, branch: string): Promise<string | null> {
    const watch = this.store.getCiWatchForRepairTask(taskId);
    if (!watch) return null;
    const row = this.store.findLatestWorkOrderByTask(taskId);
    if (!row || row.worktree !== path.resolve(worktree)) throw new Error('CI_REPAIR_WORKTREE_MISMATCH');
    if (branch !== row.branch) throw new Error('CI_REPAIR_BRANCH_MISMATCH');
    const status = await this.command('git', ['status', '--porcelain'], worktree);
    if (status.status !== 0) throw new Error('CI_REPAIR_GIT_STATUS_FAILED');
    const files = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
    const order = JSON.parse(row.payload_json) as WorkOrder;
    if (files.some((file) => !order.allowed_paths.some((allowed) => file === allowed || file.startsWith(`${allowed.replace(/\/$/, '')}/`)))) throw new Error('CI_REPAIR_PATH_VIOLATION');
    if (!files.length) throw new Error('CI_REPAIR_NO_CHANGES');
    const add = await this.command('git', ['add', '--', ...files], worktree); if (add.status !== 0) throw new Error('CI_REPAIR_STAGE_FAILED');
    const commit = await this.command('git', ['-c', 'user.name=Agent Forge Supervisor', '-c', 'user.email=agent-forge@localhost', 'commit', '-m', `repair: ${taskId}`], worktree); if (commit.status !== 0) throw new Error('CI_REPAIR_COMMIT_FAILED');
    const head = await this.command('git', ['rev-parse', 'HEAD'], worktree); if (head.status !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) throw new Error('CI_REPAIR_HEAD_FAILED');
    const push = await this.command('git', ['push', 'origin', `HEAD:refs/heads/${watch.branch}`, `--force-with-lease=refs/heads/${watch.branch}:${watch.expected_head_sha}`], worktree); if (push.status !== 0) throw new Error(`CI_REPAIR_PUSH_FAILED: ${sanitizeAutonomyText(push.stderr)}`);
    const newHead = head.stdout.trim().toLowerCase();
    this.store.updateCiWatch(watch.id, { expected_head_sha: newHead, state: 'CI_WAIT', poll_attempt: 0, next_poll_at: new Date().toISOString() });
    this.store.updateState(row.id, 'CI_WAIT', row.lease_epoch);
    this.store.event(row.id, 'CI_REPAIR_PUSHED', { headSha: newHead, branch: watch.branch });
    return newHead;
  }
}
