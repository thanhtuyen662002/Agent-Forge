import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { ProcessRunner, ProcessRunResult } from '../services/ProcessRunner';
import {
  ManagerReview,
  ManagerReviewSchema,
  ProviderFailure,
  WorkOrder,
  parseManagerReview,
  parseWorkOrder,
  sanitizeAutonomyText,
} from './contracts';

export interface ProviderRun {
  status: ProviderFailure;
  exitCode: number;
  executionId: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

function classifyProcess(result: ProcessRunResult): ProviderFailure {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.errorCode === 'TIMEOUT' || result.timedOut) return 'TIMEOUT';
  if (result.errorCode === 'CANCELLED' || result.cancelled) return 'CANCELLED';
  if (/no output produced|headless mode cannot prompt|auto-denied/.test(output)) return 'CONTRACT_INVALID';
  if (result.errorCode === 'PROCESS_LAUNCH_FAILED' || result.processStart === 'NOT_STARTED_PROVEN') return 'PROCESS_NOT_FOUND';
  if (/not authenticated|authentication required|not logged in|unauthorized|invalid token|login required/i.test(output)) return 'AUTH_ERROR';
  if (result.exitCode !== 0 && /quota|rate limit|resource exhausted|usage limit|at capacity/i.test(output)) return 'QUOTA_OR_RATE_LIMIT';
  return result.exitCode === 0 ? 'SUCCESSFUL_PROCESS_EXIT' : 'FAILED_PROCESS_EXIT';
}

function executableFromPath(name: string): string | null {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const pathValue = process.env.Path ?? process.env.PATH ?? '';
  const candidates = pathValue.split(path.delimiter).filter(Boolean).flatMap((dir) => [
    path.join(dir, name),
    process.platform === 'win32' ? path.join(dir, `${name}.exe`) : path.join(dir, `${name}.cmd`),
  ]);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export interface AntigravityAdapterOptions {
  executable?: string;
  timeoutMs?: number;
  runner?: typeof ProcessRunner.execute;
}

export class AntigravityAdapter {
  readonly id = 'antigravity-cli';
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly runner: typeof ProcessRunner.execute;
  private activeExecutionId: string | null = null;

  constructor(options: AntigravityAdapterOptions = {}) {
    const configured = options.executable ?? process.env.AGY_EXECUTABLE ?? 'agy';
    this.executable = executableFromPath(configured) ?? configured;
    this.timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
    this.runner = options.runner ?? ((input) => ProcessRunner.execute(input));
  }

  getExecutable(): string { return this.executable; }

  async version(): Promise<ProviderRun> {
    return this.run(['--version'], process.cwd(), '');
  }

  async contract(worktree = process.cwd()): Promise<ProviderRun> {
    return this.run(['-p', 'Reply exactly: AGY_OK'], worktree, '');
  }

  async execute(order: WorkOrder): Promise<ProviderRun> {
    const root = path.resolve(order.worktree);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { status: 'CONTRACT_INVALID', exitCode: -1, executionId: '', stdout: '', stderr: 'Worktree does not exist', durationMs: 0 };
    }
    const prompt = `Implement exactly this authorized WorkOrder using file read and edit tools only. Do not call run_command or any terminal/command tool: the Supervisor exclusively runs required tests after you return. Only edit allowed paths inside the assigned worktree. Do not commit, push, merge, change branches, or edit Git metadata. Return an informational workerresult.v1 JSON object.\n${JSON.stringify(order)}`;
    return this.run(['--mode', 'accept-edits', '--sandbox', '--output-format', 'stream-json', '-p', prompt], root, '');
  }

  async cancel(): Promise<void> {
    if (this.activeExecutionId) await ProcessRunner.cancel(this.activeExecutionId);
  }

  private async run(args: string[], cwd: string, stdin: string): Promise<ProviderRun> {
    const started = Date.now();
    this.activeExecutionId = crypto.randomUUID();
    try {
      const result = await this.runner({
        executionId: this.activeExecutionId,
        executable: this.executable,
        args,
        cwd,
        timeoutMs: this.timeoutMs,
        allowShell: false,
        // Explicitly close stdin. Codex may otherwise wait for additional
        // interactive input because ProcessRunner creates a piped stdin.
        stdin,
      });
      this.activeExecutionId = result.executionId;
      const run: ProviderRun = {
        status: classifyProcess(result),
        exitCode: result.exitCode,
        executionId: result.executionId,
        stdout: sanitizeAutonomyText(result.stdout),
        stderr: sanitizeAutonomyText(result.stderr),
        durationMs: result.durationMs || Date.now() - started,
        error: result.error?.message,
      };
      this.activeExecutionId = null;
      return run;
    } catch (error) {
      this.activeExecutionId = null;
      return {
        status: 'PROCESS_NOT_FOUND',
        exitCode: -1,
        executionId: '',
        stdout: '',
        stderr: sanitizeAutonomyText(error instanceof Error ? error.message : String(error)),
        durationMs: Date.now() - started,
      };
    }
  }
}

export interface ManagerProviderOptions {
  executable?: string;
  timeoutMs?: number;
  runner?: typeof ProcessRunner.execute;
}

export interface ManagerEvidence {
  workOrder: WorkOrder;
  evidence: string;
}

export class CodexManagerAdapter {
  readonly id = 'codex-cli-manager';
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly runner: typeof ProcessRunner.execute;

  constructor(options: ManagerProviderOptions = {}) {
    const defaultExecutable = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
      : 'codex';
    const configured = options.executable ?? process.env.CODEX_EXECUTABLE ?? defaultExecutable;
    this.executable = executableFromPath(configured) ?? configured;
    // Keep manager calls bounded during bootstrap. A hung provider must not
    // hold the only pilot worker indefinitely; callers can retry from durable
    // state after a timeout.
    this.timeoutMs = options.timeoutMs ?? 2 * 60 * 1000;
    this.runner = options.runner ?? ((input) => ProcessRunner.execute(input));
  }

  getExecutable(): string { return this.executable; }

  async version(): Promise<ProviderRun> {
    return this.run(['--version'], process.cwd(), '');
  }

  async contract(worktree = process.cwd()): Promise<ProviderRun> {
    return this.run([...this.execArgs(), 'Reply exactly: CODEX_OK'], worktree, '');
  }

  async review(input: ManagerEvidence): Promise<{ run: ProviderRun; review?: ManagerReview }> {
    const prompt = [
      'You are the Agent Forge manager. Review only the evidence below.',
      'Return exactly one JSON object matching managerreview.v1; no markdown.',
      'A PASS is valid only when reviewed_head_sha equals the evidence current HEAD.',
      'Return fields protocol_version:"managerreview.v1", verdict:"PASS"|"REPAIR"|"BLOCKED", reviewed_head_sha:string, findings:array of {severity:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL",title:string,description:string}, required_actions:string[], risk:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL", notes:string.',
      'Use the supplied evidence. Do not change files. Failed tests or missing acceptance evidence cannot PASS.',
      JSON.stringify(input),
    ].join('\n');
    // Plain non-interactive output is the most portable Codex contract across
    // installed versions. The prompt requires one JSON object, and the
    // parser independently validates it before accepting the decision.
    const run = await this.run([...this.execArgs(), '-'], input.workOrder.worktree, prompt);
    if (run.status !== 'SUCCESSFUL_PROCESS_EXIT') return { run };
    try {
      const review = ManagerReviewSchema.parse(parseManagerReview(run.stdout));
      return { run, review };
    } catch (error) {
      return {
        run: { ...run, status: 'CONTRACT_INVALID', error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async plan(seed: Pick<WorkOrder, 'task_id' | 'worker_id' | 'base_sha' | 'branch' | 'worktree' | 'objective' | 'acceptance_criteria'> & Partial<Pick<WorkOrder, 'required_tests' | 'constraints' | 'allowed_paths' | 'forbidden_paths'>>): Promise<{ run: ProviderRun; workOrder?: WorkOrder }> {
    const prompt = [
      'You are a deterministic Agent Forge manager. Create one executable WorkOrder for the disposable objective below.',
      'Do not run tools, inspect files, or reason aloud. Use only the seeded data.',
      'Return exactly one JSON object matching workorder.v1; preserve every seeded identity and path exactly.',
      'Use no forbidden paths and keep the task limited to the objective.',
      JSON.stringify({ protocol_version: 'workorder.v1', ...seed, issue_number: null, dependencies: [], allowed_paths: seed.allowed_paths ?? [], forbidden_paths: seed.forbidden_paths ?? ['.git', 'main', 'D:/Projects/Agent-Forge'], required_tests: seed.required_tests ?? [], context_files: [], constraints: seed.constraints ?? [], attempt: 1, lease_epoch: 1 }),
    ].join('\n');
    const run = await this.run([...this.execArgs(), '-'], seed.worktree, prompt);
    if (run.status !== 'SUCCESSFUL_PROCESS_EXIT') return { run };
    try {
      const workOrder = parseWorkOrder(run.stdout);
      for (const [key, value] of Object.entries(seed)) {
        if (JSON.stringify(workOrder[key as keyof WorkOrder]) !== JSON.stringify(value)) throw new Error(`CONTRACT_INVALID: manager changed authorized ${key}`);
      }
      return { run, workOrder };
    }
    catch (error) { return { run: { ...run, status: 'CONTRACT_INVALID', error: error instanceof Error ? error.message : String(error) } }; }
  }

  private execArgs(): string[] {
    return [
      'exec',
      '--ignore-user-config',
      '--json',
      '--model',
      process.env.CODEX_MANAGER_MODEL ?? 'gpt-5.6-terra',
      '-c',
      'model_reasoning_effort="low"',
      '--sandbox',
      'read-only',
      '--color',
      'never',
    ];
  }

  private async run(args: string[], cwd: string, stdin: string): Promise<ProviderRun> {
    const started = Date.now();
    try {
      const result = await this.runner({
        executable: this.executable,
        args,
        cwd,
        timeoutMs: this.timeoutMs,
        allowShell: false,
        stdin,
      });
      return {
        status: classifyProcess(result),
        exitCode: result.exitCode,
        executionId: result.executionId,
        stdout: sanitizeAutonomyText(result.stdout),
        stderr: sanitizeAutonomyText(result.stderr),
        durationMs: result.durationMs || Date.now() - started,
        error: result.error?.message,
      };
    } catch (error) {
      return {
        status: 'PROCESS_NOT_FOUND', exitCode: -1, executionId: '', stdout: '',
        stderr: sanitizeAutonomyText(error instanceof Error ? error.message : String(error)),
        durationMs: Date.now() - started,
      };
    }
  }
}

export function defaultRuntimeRoot(): string {
  return process.env.AGENT_FORGE_RUNTIME_ROOT ?? path.join(os.homedir(), 'Agent-Forge-Runtime');
}
