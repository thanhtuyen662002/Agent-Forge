import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  LocalCliAdapterBase,
  LocalCliAdapterOptions,
} from './LocalCliAdapterBase';
import { Capability, ProviderHealthStatus } from '../types/domain';
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  RuntimeErrorCode,
} from './ProviderAdapter';
import { NativeProfileResolver } from '../credentials/NativeProfileResolver';
import { parseNativeProfileRef } from '../credentials/NativeProfileRef';
import { ProcessRunner, ProcessRunResult } from '../services/ProcessRunner';

export interface GeminiCliAdapterOptions extends LocalCliAdapterOptions {
  profileResolver?: NativeProfileResolver;
}

export class GeminiCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-gemini-cli';
  public readonly name: string = 'Gemini CLI';
  public readonly capabilities: Capability[] = [
    'CODING',
    'FILESYSTEM_EDIT',
    'TEST_EXECUTION',
    'TERMINAL',
  ];

  readonly #profileResolver: NativeProfileResolver;

  constructor(options?: GeminiCliAdapterOptions) {
    super(options);
    this.#profileResolver = options?.profileResolver ?? new NativeProfileResolver();
  }

  protected getDefaultExecutable(): string {
    if (process.platform === 'win32') {
      const candidates: (string | undefined)[] = [
        process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, 'gemini.cmd') : undefined,
        process.execPath ? path.join(path.dirname(process.execPath), 'gemini.cmd') : undefined,
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'gemini.cmd') : undefined,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'gemini.cmd') : undefined,
      ];

      for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
          return candidate;
        }
      }

      return 'C:\\nvm4w\\nodejs\\gemini.cmd';
    }

    const posixCandidates: (string | undefined)[] = [
      process.execPath ? path.join(path.dirname(process.execPath), 'gemini') : undefined,
      '/usr/local/bin/gemini',
      '/usr/bin/gemini',
    ];

    for (const candidate of posixCandidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return '/usr/local/bin/gemini';
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'TERMINAL'];
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
      GEMINI_CLI_HOME: resolution.profileDirectory,
    };
  }

  protected override getAllowedEnvironmentOverrideKeys(
    _request?: AgentExecutionRequest
  ): string[] {
    return ['GEMINI_CLI_HOME'];
  }

  protected override buildExecutionArgs(
    request: AgentExecutionRequest,
    _prompt: string
  ): string[] {
    const modelName = request.runtimeBinding?.modelName;
    return [
      '--prompt',
      '',
      '--output-format',
      'json',
      '--model',
      modelName ?? '',
      '--sandbox',
      '--approval-mode',
      'default',
    ];
  }

  protected override extractProtocolText(
    _request: AgentExecutionRequest,
    rawStdout: string
  ): string | null {
    const trimmed = rawStdout.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }

      if (typeof parsed.response !== 'string') {
        return null;
      }

      const responseText = parsed.response.trim();
      return responseText.length > 0 ? responseText : null;
    } catch {
      return null;
    }
  }

  protected override classifyProviderProcessFailure(
    _request: AgentExecutionRequest,
    result: ProcessRunResult
  ): { errorCode: RuntimeErrorCode; error: string } | null {
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    // Auth error explicit markers
    const authRegex =
      /(?:authentication failed|unauthorized|not logged in|login required|session expired|invalid token|invalid api key|missing credentials|authentication error|oauth error)/i;
    if (authRegex.test(combinedOutput)) {
      return {
        errorCode: 'AUTH_ERROR',
        error: result.stderr || result.stdout || 'Gemini authentication failed.',
      };
    }

    // Quota error explicit markers
    const quotaRegex =
      /(?:quota exceeded|rate limit|insufficient quota|credit balance|usage limit|exceeded your current quota|resource exhausted|resource_exhausted)/i;
    if (quotaRegex.test(combinedOutput)) {
      return {
        errorCode: 'QUOTA_EXHAUSTED',
        error: result.stderr || result.stdout || 'Gemini quota exhausted.',
      };
    }

    // Unsupported client explicit markers
    const unsupportedClientRegex =
      /(?:unsupported client|unsupported_client|client is not supported|legacy consumer client|oauth client not supported)/i;
    if (unsupportedClientRegex.test(combinedOutput)) {
      return {
        errorCode: 'UNSUPPORTED_CLIENT',
        error:
          result.stderr ||
          result.stdout ||
          'Gemini CLI returned UNSUPPORTED_CLIENT runtime state.',
      };
    }

    return null;
  }

  public override async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();

    // 1. Mandatory RuntimeExecutionBinding validation before any process spawn
    if (!request.runtimeBinding) {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'RUNTIME_BINDING_MISSING: GeminiCliAdapter requires durable RuntimeExecutionBinding.',
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
        error: 'PROFILE_REF_MISSING: Gemini execution requires a valid profileRef.',
      };
    }

    if (!modelName || typeof modelName !== 'string' || modelName.trim() === '') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'MODEL_NAME_MISSING: Gemini execution requires a non-empty modelName in runtimeBinding.',
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

    if (canonicalProfileRef.getProvider() !== 'gemini') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: `PROVIDER_MISMATCH: Profile provider "${canonicalProfileRef.getProvider()}" is not supported by GeminiCliAdapter.`,
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

    // 4. Delegate to LocalCliAdapterBase.execute
    return super.execute(request);
  }
}
