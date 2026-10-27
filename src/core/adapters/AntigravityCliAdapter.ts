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
import type { AntigravityCredentialSlots } from '../credentials/AntigravityCredentialSlots';

export interface AntigravityCliAdapterOptions extends LocalCliAdapterOptions {
  profileResolver?: NativeProfileResolver;
  /** Per-account sign-ins (#304); without it every run uses the machine-wide sign-in. */
  credentialSlots?: AntigravityCredentialSlots | null;
}

/** Windows command lines are limited to 32,767 characters; the prompt travels as an argument. */
export const MAX_ANTIGRAVITY_PROMPT_CHARS = 24_000;

/**
 * Antigravity CLI (`agy`, #265): Google's replacement for Gemini CLI's
 * personal sign-in. Print mode with `--output-format json`; a coder runs in
 * `accept-edits` mode inside the sandbox, a reviewer or Manager in read-only
 * `plan` mode. Permission-bypass flags are never used. Each agent's profile
 * isolates the CLI's state (home folder); the Google sign-in itself is
 * machine-wide in the OS credential store.
 */
export class AntigravityCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-antigravity-cli';
  public readonly name: string = 'Antigravity CLI';

  readonly #profileResolver: NativeProfileResolver;
  readonly #credentialSlots: AntigravityCredentialSlots | null;

  constructor(options?: AntigravityCliAdapterOptions) {
    // The prompt is the value of `-p`; stdin stays empty.
    super({ timeoutMs: 20 * 60_000, ...options, useStdin: false });
    this.#profileResolver = options?.profileResolver ?? new NativeProfileResolver();
    this.#credentialSlots = options?.credentialSlots ?? null;
  }

  protected getDefaultExecutable(): string {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'agy', 'bin', 'agy.exe');
    }
    return 'agy';
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT', 'REVIEW', 'PLANNING'];
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
    const directory = this.#profileResolver.resolve(request.runtimeBinding.profileRef).profileDirectory;
    return { USERPROFILE: directory, HOME: directory };
  }

  protected override getAllowedEnvironmentOverrideKeys(_request?: AgentExecutionRequest): string[] {
    return ['USERPROFILE', 'HOME'];
  }

  /** An empty, closed stdin: print mode would otherwise wait to append piped input to the prompt. */
  protected override buildStdin(_prompt: string): string {
    return '';
  }

  protected override buildExecutionArgs(request: AgentExecutionRequest, prompt: string): string[] {
    return buildAntigravityArgs(request.expectedProtocol, request.runtimeBinding?.modelName ?? '', prompt);
  }

  protected override extractProtocolText(_request: AgentExecutionRequest, rawStdout: string): string | null {
    const result = parseAntigravityResult(rawStdout);
    if (!result || result.status !== 'SUCCESS' || typeof result.response !== 'string') return null;
    const text = result.response.trim();
    return text.length > 0 ? text : null;
  }

  protected override classifyProviderProcessFailure(
    _request: AgentExecutionRequest,
    result: ProcessRunResult,
  ): { errorCode: RuntimeErrorCode; error: string } | null {
    return classifyAntigravityFailure(result.stdout, result.stderr);
  }

  public override async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();
    const fail = (error: string): AgentExecutionResult => ({ executionId, status: 'FAILED', errorCode: 'RESOURCE_UNAVAILABLE', error });
    if (!request.runtimeBinding) return fail('RUNTIME_BINDING_MISSING: AntigravityCliAdapter requires durable RuntimeExecutionBinding.');
    const { adapterType, accountAuthMode, profileRef, modelName } = request.runtimeBinding;
    if (adapterType !== 'LOCAL_CLI') return fail(`INVALID_ADAPTER_TYPE: Expected LOCAL_CLI but received "${adapterType}".`);
    if (accountAuthMode !== 'NATIVE_PROFILE') return fail(`INVALID_AUTH_MODE: Expected NATIVE_PROFILE but received "${accountAuthMode}".`);
    if (!profileRef || typeof profileRef !== 'string' || profileRef.trim() === '') return fail('PROFILE_REF_MISSING: Antigravity execution requires a valid profileRef.');
    if (!modelName || typeof modelName !== 'string' || modelName.trim() === '') return fail('MODEL_NAME_MISSING: Antigravity execution requires a non-empty modelName.');
    if (this.buildPrompt(request).length > MAX_ANTIGRAVITY_PROMPT_CHARS) return fail('PROMPT_TOO_LONG: The task prompt exceeds the Antigravity command-line limit; narrow the task context.');
    try {
      const ref = parseNativeProfileRef(profileRef);
      if (ref.getProvider() !== 'antigravity') return fail(`PROVIDER_MISMATCH: Profile provider "${ref.getProvider()}" is not supported by AntigravityCliAdapter.`);
      const directory = this.#profileResolver.resolve(ref).profileDirectory;
      // The profile only holds the CLI's own state; create it on first use.
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      return fail(`PROFILE_RESOLUTION_FAILED: ${error instanceof Error ? error.message : 'profile could not be resolved'}`);
    }
    // agy reads one machine-wide sign-in: each run swaps in its own account's sign-in, one run at a time (#304).
    const slots = this.#credentialSlots;
    return slots ? slots.withAccount(request.runtimeBinding.accountId, () => super.execute(request)) : super.execute(request);
  }
}

/** Read-only roles plan; a coder may only accept edits, inside the sandbox. `-p` and its prompt come last. */
export function buildAntigravityArgs(expectedProtocol: string | undefined, modelName: string, prompt: string): string[] {
  const readOnly = expectedProtocol === 'review.v1' || expectedProtocol === 'manager.v1' || expectedProtocol === 'plan.v1';
  return [
    '--output-format', 'json', '--model', modelName,
    ...(readOnly ? ['--mode', 'plan'] : ['--mode', 'accept-edits', '--sandbox']),
    '--disable-slash-commands',
    '-p', prompt,
  ];
}

export interface AntigravityResult { status?: unknown; response?: unknown; error?: unknown }

/** The last JSON object on stdout (`--output-format json` prints one result object). */
export function parseAntigravityResult(stdout: string): AntigravityResult | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as AntigravityResult;
    } catch { /* not JSON */ }
  }
  return null;
}

/** The structured `AGY_ERROR: {...}` line the CLI writes to stderr on failure. */
function parseAgyError(stderr: string): { status?: unknown; error_code?: unknown; short_error?: unknown } | null {
  const match = /^AGY_ERROR:\s*(\{.*\})\s*$/m.exec(stderr);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Observed on agy 1.4.6 (2026-10-25): exit 3 with `status: "ERROR"` and
 * `AGY_ERROR {status: "RESOURCE_EXHAUSTED", error_code: 429}` for "Individual
 * quota reached … Resets in 117h59m19s". Only the CLI's own error fields are
 * classified, never the model's free text; unknown stays unclassified.
 */
export function classifyAntigravityFailure(stdout: string, stderr: string): { errorCode: RuntimeErrorCode; error: string } | null {
  const result = parseAntigravityResult(stdout);
  const agy = parseAgyError(stderr);
  const message = [typeof result?.error === 'string' ? result.error : '', typeof agy?.short_error === 'string' ? agy.short_error : ''].join('\n');
  const status = typeof agy?.status === 'string' ? agy.status : '';
  const code = typeof agy?.error_code === 'number' ? agy.error_code : null;
  if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED' || code === 401 ||
      /not signed in|sign in required|please (?:sign|log) in|login required|authentication (?:failed|required)|auth_revoked|failed to load cli credentials/i.test(message)) {
    return { errorCode: 'AUTH_ERROR', error: 'Antigravity is not signed in on this machine, or the sign-in expired.' };
  }
  // Observed 2026-10-27 (#302): Google asks to verify the account before Antigravity runs.
  if (/eligibility check failed|not eligible for antigravity|verify your account/i.test(message)) {
    return { errorCode: 'AUTH_ERROR', error: 'Google asks to verify this Antigravity account in the browser before it can run (sign in again from Agent Center).' };
  }
  if (status === 'RESOURCE_EXHAUSTED' || code === 429 || /quota reached|rate limit/i.test(message)) {
    const resets = /resets in ([0-9hms ]{2,20})/i.exec(message);
    return { errorCode: 'QUOTA_EXHAUSTED', error: resets ? `Antigravity quota reached; resets in ${resets[1].trim()}.` : 'Antigravity quota reached.' };
  }
  return null;
}
