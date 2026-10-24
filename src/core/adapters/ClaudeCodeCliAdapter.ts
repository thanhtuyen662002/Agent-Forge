import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { LocalCliAdapterBase, LocalCliAdapterOptions } from './LocalCliAdapterBase';
import { Capability, ProviderHealthStatus } from '../types/domain';
import { AgentExecutionRequest, AgentExecutionResult, RuntimeErrorCode } from './ProviderAdapter';
import { NativeProfileResolver } from '../credentials/NativeProfileResolver';
import { parseNativeProfileRef } from '../credentials/NativeProfileRef';
import { ProcessRunResult } from '../services/ProcessRunner';

export interface ClaudeCodeCliAdapterOptions extends LocalCliAdapterOptions {
  profileResolver?: NativeProfileResolver;
  /** Turn budget per run; bounded so a run can never loop forever. */
  maxTurns?: number;
}

/** Built-in tools a coder may use: file tools only, never a shell or the network. */
const CODER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
/** Read-only tools for a reviewer or Manager. */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/**
 * Claude Code CLI (#242). Each account has its own `CLAUDE_CONFIG_DIR`
 * profile; ProcessRunner passes only a minimal environment, so ANTHROPIC_*
 * credentials of the host never reach the child. A coder runs with
 * `acceptEdits` and file tools only; a reviewer or Manager runs with
 * `dontAsk` and read-only tools. Permission-bypass flags are never used.
 */
export class ClaudeCodeCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-claude-code-cli';
  public readonly name: string = 'Claude Code CLI';

  readonly #profileResolver: NativeProfileResolver;
  readonly #maxTurns: number;

  constructor(options?: ClaudeCodeCliAdapterOptions) {
    super(options);
    this.#profileResolver = options?.profileResolver ?? new NativeProfileResolver();
    this.#maxTurns = Math.min(100, Math.max(1, options?.maxTurns ?? 40));
  }

  protected getDefaultExecutable(): string {
    if (process.platform === 'win32') {
      // The native installer puts claude.exe here; an npm .cmd shim cannot be spawned without a shell.
      const home = process.env.USERPROFILE || os.homedir();
      return path.join(home, '.local', 'bin', 'claude.exe');
    }
    return 'claude';
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW', 'PLANNING'];
  }

  public override async getHealth(): Promise<ProviderHealthStatus> {
    try {
      const res = await this.executeHealthProbe(this.resolveExecutionEnvironment(), this.getAllowedEnvironmentOverrideKeys());
      if (res.cancelled) return 'UNHEALTHY';
      return res.exitCode === 0 ? 'AVAILABLE' : 'OFFLINE';
    } catch {
      return 'OFFLINE';
    }
  }

  protected override resolveExecutionEnvironment(request?: AgentExecutionRequest): Record<string, string> | undefined {
    if (!request?.runtimeBinding?.profileRef) return undefined;
    return { CLAUDE_CONFIG_DIR: this.#profileResolver.resolve(request.runtimeBinding.profileRef).profileDirectory };
  }

  protected override getAllowedEnvironmentOverrideKeys(_request?: AgentExecutionRequest): string[] {
    return ['CLAUDE_CONFIG_DIR'];
  }

  protected override buildExecutionArgs(request: AgentExecutionRequest, _prompt: string): string[] {
    const readOnly = request.expectedProtocol === 'review.v1' || request.expectedProtocol === 'manager.v1';
    // The prompt arrives on stdin. Variadic tool lists come last so they cannot swallow other flags.
    return [
      '-p', '--output-format', 'json', '--model', request.runtimeBinding?.modelName ?? '',
      '--max-turns', String(this.#maxTurns), '--no-session-persistence',
      ...(readOnly
        ? ['--permission-mode', 'dontAsk', '--tools', READ_ONLY_TOOLS.join(',')]
        : ['--permission-mode', 'acceptEdits', '--tools', CODER_TOOLS.join(',')]),
    ];
  }

  /** The final assistant text of `--output-format json`; an error result yields no protocol. */
  protected override extractProtocolText(_request: AgentExecutionRequest, rawStdout: string): string | null {
    const result = parseClaudeResult(rawStdout);
    if (!result || result.is_error === true || typeof result.result !== 'string') return null;
    return result.result;
  }

  protected override classifyProviderProcessFailure(
    _request: AgentExecutionRequest,
    result: ProcessRunResult,
  ): { errorCode: RuntimeErrorCode; error: string } | null {
    return classifyClaudeFailure(`${parseClaudeResult(result.stdout)?.result ?? ''}\n${result.stdout}\n${result.stderr}`);
  }

  public override async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();
    const fail = (error: string): AgentExecutionResult => ({ executionId, status: 'FAILED', errorCode: 'RESOURCE_UNAVAILABLE', error });
    if (!request.runtimeBinding) return fail('RUNTIME_BINDING_MISSING: ClaudeCodeCliAdapter requires durable RuntimeExecutionBinding.');
    const { adapterType, accountAuthMode, profileRef, modelName } = request.runtimeBinding;
    if (adapterType !== 'LOCAL_CLI') return fail(`INVALID_ADAPTER_TYPE: Expected LOCAL_CLI but received "${adapterType}".`);
    if (accountAuthMode !== 'NATIVE_PROFILE') return fail(`INVALID_AUTH_MODE: Expected NATIVE_PROFILE but received "${accountAuthMode}".`);
    if (!profileRef || typeof profileRef !== 'string' || profileRef.trim() === '') return fail('PROFILE_REF_MISSING: Claude Code execution requires a valid profileRef.');
    if (!modelName || typeof modelName !== 'string' || modelName.trim() === '') return fail('MODEL_NAME_MISSING: Claude Code execution requires a non-empty modelName.');
    let profileDirectory: string;
    try {
      const ref = parseNativeProfileRef(profileRef);
      if (ref.getProvider() !== 'claude') return fail(`PROVIDER_MISMATCH: Profile provider "${ref.getProvider()}" is not supported by ClaudeCodeCliAdapter.`);
      profileDirectory = this.#profileResolver.resolve(ref).profileDirectory;
    } catch (error) {
      return fail(`PROFILE_RESOLUTION_FAILED: ${error instanceof Error ? error.message : 'profile could not be resolved'}`);
    }
    try {
      if (!fs.statSync(profileDirectory).isDirectory()) return fail('PROFILE_PATH_NOT_A_DIRECTORY: Resolved Claude profile path is not a directory.');
    } catch {
      return fail('PROFILE_DIRECTORY_NOT_FOUND: Sign this account in first; its Claude profile directory does not exist.');
    }
    return super.execute(request);
  }
}

/** The last JSON object on stdout (`--output-format json` prints one result object). */
export function parseClaudeResult(stdout: string): { result?: unknown; is_error?: unknown; subtype?: unknown } | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* not JSON */ }
  }
  return null;
}

/** Documented Claude Code error texts (code.claude.com/docs/en/errors). Wording may change; unknown stays unclassified. */
export function classifyClaudeFailure(text: string): { errorCode: RuntimeErrorCode; error: string } | null {
  if (/not logged in|login expired|please run \/login|failed to authenticate|invalid api key|invalid authentication credentials|401/i.test(text)) {
    return { errorCode: 'AUTH_ERROR', error: 'Claude Code is not signed in for this profile, or the login expired.' };
  }
  const limit = /you['’]ve hit your (?:session|weekly|opus|sonnet)?\s*limit(?:[^\n]*?resets ([^\n"]+))?/i.exec(text);
  if (limit || /request rejected \(429\)|usage limit|rate limit/i.test(text)) {
    return { errorCode: 'QUOTA_EXHAUSTED', error: limit?.[1] ? `Claude Code usage limit reached; resets ${limit[1].trim()}.` : 'Claude Code usage limit reached.' };
  }
  return null;
}
