import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LocalCliAdapterBase, LocalCliAdapterOptions } from './LocalCliAdapterBase';
import { Capability, ProviderHealthStatus } from '../types/domain';
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  RuntimeErrorCode,
} from './ProviderAdapter';
import { NativeProfileResolver } from '../credentials/NativeProfileResolver';
import { parseNativeProfileRef } from '../credentials/NativeProfileRef';
import { ProcessRunner, ProcessRunResult } from '../services/ProcessRunner';

export interface CodexCliAdapterOptions extends LocalCliAdapterOptions {
  profileResolver?: NativeProfileResolver;
}

export class CodexCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-codex-cli';
  public readonly name: string = 'Codex CLI';

  readonly #profileResolver: NativeProfileResolver;

  constructor(options?: CodexCliAdapterOptions) {
    super(options);
    this.#profileResolver = options?.profileResolver ?? new NativeProfileResolver();
  }

  protected getDefaultExecutable(): string {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData && localAppData.trim() !== '') {
        return path.join(localAppData.trim(), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      }
      return 'C:\\Users\\Vo Thanh Tuyen\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
    }
    return 'codex';
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'TERMINAL', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'];
  }

  public override async getHealth(): Promise<ProviderHealthStatus> {
    try {
      const res = await ProcessRunner.execute({
        executable: this.executable,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 5000,
        allowShell: false,
      });

      if (res.cancelled) {
        return 'UNHEALTHY';
      }

      if (res.exitCode === 0) {
        return 'AVAILABLE';
      }

      return 'OFFLINE';
    } catch {
      return 'OFFLINE';
    }
  }

  protected override resolveExecutionEnvironment(
    request?: AgentExecutionRequest
  ): Record<string, string> | undefined {
    if (!request?.runtimeBinding?.profileRef) {
      return undefined;
    }
    const resolution = this.#profileResolver.resolve(request.runtimeBinding.profileRef);
    return {
      CODEX_HOME: resolution.profileDirectory,
    };
  }

  protected override getAllowedEnvironmentOverrideKeys(
    _request?: AgentExecutionRequest
  ): string[] {
    return ['CODEX_HOME'];
  }

  protected override buildExecutionArgs(
    request: AgentExecutionRequest,
    _prompt: string
  ): string[] {
    const modelName = request.runtimeBinding?.modelName;
    return ['exec', '--json', '--model', modelName ?? '', '--sandbox', 'workspace-write'];
  }

  protected override classifyProviderProcessFailure(
    _request: AgentExecutionRequest,
    result: ProcessRunResult
  ): { errorCode: RuntimeErrorCode; error: string } | null {
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    // Auth error explicit markers
    const authRegex = /(?:authentication failed|unauthorized|not logged in|login required|session expired|invalid token|invalid api key|missing credentials|authentication error|openai error: unauthorized)/i;
    if (authRegex.test(combinedOutput)) {
      return {
        errorCode: 'AUTH_ERROR',
        error: result.stderr || result.stdout || 'Codex authentication failed.',
      };
    }

    // Quota error explicit markers
    const quotaRegex = /(?:quota exceeded|rate limit|insufficient quota|credit balance|usage limit|exceeded your current quota|quotaexceedederror)/i;
    if (quotaRegex.test(combinedOutput)) {
      return {
        errorCode: 'QUOTA_EXHAUSTED',
        error: result.stderr || result.stdout || 'Codex quota exhausted.',
      };
    }

    return null;
  }

  protected override extractProtocolText(
    _request: AgentExecutionRequest,
    rawStdout: string
  ): string | null {
    const lines = rawStdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    let lastAgentMessageText: string | null = null;

    for (const line of lines) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // Any non-empty malformed JSONL line fails closed
        return null;
      }

      if (
        event &&
        typeof event === 'object' &&
        event.type === 'item.completed' &&
        event.item &&
        typeof event.item === 'object' &&
        event.item.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        lastAgentMessageText = event.item.text;
      }
    }

    return lastAgentMessageText;
  }

  public override async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();

    // 1. Mandatory RuntimeExecutionBinding validation before any process spawn
    if (!request.runtimeBinding) {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'RUNTIME_BINDING_MISSING: CodexCliAdapter requires durable RuntimeExecutionBinding.',
      };
    }

    const { adapterType, accountAuthMode, profileRef, modelName } = request.runtimeBinding;

    if (adapterType !== 'LOCAL_CLI') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `INVALID_ADAPTER_TYPE: Expected LOCAL_CLI but received "${adapterType}".`,
      };
    }

    if (accountAuthMode !== 'NATIVE_PROFILE') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `INVALID_AUTH_MODE: Expected NATIVE_PROFILE but received "${accountAuthMode}".`,
      };
    }

    if (!profileRef || typeof profileRef !== 'string' || profileRef.trim() === '') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'PROFILE_REF_MISSING: Codex execution requires a valid profileRef.',
      };
    }

    if (!modelName || typeof modelName !== 'string' || modelName.trim() === '') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'MODEL_NAME_MISSING: Codex execution requires a non-empty modelName in runtimeBinding.',
      };
    }

    // 2. Profile Provider Validation
    let canonicalProfileRef;
    try {
      canonicalProfileRef = parseNativeProfileRef(profileRef);
    } catch (err: any) {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `INVALID_PROFILE_REF: ${err.message}`,
      };
    }

    if (canonicalProfileRef.getProvider() !== 'codex') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `PROVIDER_MISMATCH: Profile provider "${canonicalProfileRef.getProvider()}" is not supported by CodexCliAdapter.`,
      };
    }

    // 3. Resolve Native Profile Directory and verify physical existence
    let resolution;
    try {
      resolution = this.#profileResolver.resolve(canonicalProfileRef);
    } catch (err: any) {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `PROFILE_RESOLUTION_FAILED: ${err.message}`,
      };
    }

    if (!fs.existsSync(resolution.profileDirectory)) {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `PROFILE_DIRECTORY_NOT_FOUND: Resolved profile directory does not exist: ${resolution.profileDirectory}`,
      };
    }

    try {
      const stat = fs.statSync(resolution.profileDirectory);
      if (!stat.isDirectory()) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `PROFILE_PATH_NOT_A_DIRECTORY: Resolved profile path is not a directory: ${resolution.profileDirectory}`,
        };
      }
    } catch (err: any) {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `CANNOT_ACCESS_PROFILE_DIRECTORY: ${err.message}`,
      };
    }

    // 4. Delegate to LocalCliAdapterBase.execute (handles repo resolution, policy, runner, protocol parsing)
    return super.execute(request);
  }
}
