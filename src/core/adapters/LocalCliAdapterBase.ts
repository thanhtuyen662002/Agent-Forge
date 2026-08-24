import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  ProviderAdapter,
  QuotaSnapshotInfo,
  AgentExecutionRequest,
  AgentExecutionResult,
} from './ProviderAdapter';
import { Capability, ProviderHealthStatus, ProviderAdapterType } from '../types/domain';
import { Repository } from '../database/repositories';
import { ArtifactStore } from '../services/ArtifactStore';
import { ProcessRunner } from '../services/ProcessRunner';
import { PolicyService } from '../services/PolicyService';
import { ProtocolParser } from '../protocol/parser';

export interface LocalCliAdapterOptions {
  executable?: string;
  timeoutMs?: number;
  useStdin?: boolean;
  env?: Record<string, string>;
  repo?: Repository;
  artifactStore?: ArtifactStore;
}

export abstract class LocalCliAdapterBase implements ProviderAdapter {
  public abstract readonly id: string;
  public abstract readonly name: string;
  public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI';

  protected executable: string;
  protected timeoutMs: number;
  protected useStdin: boolean;
  protected env?: Record<string, string>;
  protected repo?: Repository;
  protected artifactStore?: ArtifactStore;

  constructor(options?: LocalCliAdapterOptions) {
    this.executable = options?.executable || this.getDefaultExecutable();
    this.timeoutMs = options?.timeoutMs ?? 120000;
    this.useStdin = options?.useStdin ?? true;
    this.env = options?.env;
    this.repo = options?.repo;
    this.artifactStore = options?.artifactStore;
  }

  protected abstract getDefaultExecutable(): string;
  public abstract getCapabilities(): Promise<Capability[]>;

  public setRepository(repo: Repository): void {
    this.repo = repo;
  }

  public setArtifactStore(artifactStore: ArtifactStore): void {
    this.artifactStore = artifactStore;
  }

  public setExecutable(executable: string): void {
    this.executable = executable;
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    // Local CLIs do not provide authoritative machine-readable quota telemetry
    return {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN',
      confidence: 0.0,
      resetAt: null,
    };
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    try {
      // Execute a non-destructive version probe
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

      const combinedErr = `${res.stdout} ${res.stderr}`.toLowerCase();
      if (
        combinedErr.includes('auth') ||
        combinedErr.includes('unauthorized') ||
        combinedErr.includes('login') ||
        combinedErr.includes('not logged in') ||
        combinedErr.includes('token')
      ) {
        return 'AUTH_ERROR';
      }

      return 'OFFLINE';
    } catch {
      return 'OFFLINE';
    }
  }

  protected buildPrompt(request: AgentExecutionRequest): string {
    const lines: string[] = [
      `TASK ID: ${request.taskId}`,
      `PROJECT ID: ${request.projectId}`,
      '',
      'INSTRUCTIONS:',
      ...request.instructions.map((i) => `- ${i}`),
    ];

    if (request.contextFiles.length > 0) {
      lines.push('');
      lines.push('CONTEXT FILES:');
      lines.push(...request.contextFiles.map((f) => `- ${f}`));
    }

    lines.push('');
    lines.push('OUTPUT REQUIREMENT:');
    lines.push(
      'Emit a valid JSON coder.v1 protocol object conforming to the CoderProtocol schema upon task completion.'
    );

    return lines.join('\n');
  }

  protected buildExecutionArgs(request: AgentExecutionRequest, _prompt: string): string[] {
    // When using stdin, no extra arguments needed beyond default execution mode
    return [];
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();

    // 1. Mandatory Repository Dependency Gate: Fail closed immediately if repo is absent (no spawn, no process.cwd fallback)
    if (!this.repo) {
      return {
        executionId,
        status: 'FAILED',
        error: 'PROVIDER_REPOSITORY_NOT_CONFIGURED: Local CLI adapter requires a configured Repository to resolve durable project working directory.',
      };
    }

    // 2. Resolve target project repository path from durable database state
    const project = this.repo.getProject(request.projectId);
    if (!project) {
      return {
        executionId,
        status: 'FAILED',
        error: `Project "${request.projectId}" not found in database.`,
      };
    }
    const repoPath = path.normalize(path.resolve(project.repository_path));

    // 3. Validate repository directory existence
    if (!fs.existsSync(repoPath)) {
      return {
        executionId,
        status: 'FAILED',
        error: `Project repository path does not exist on disk: ${repoPath}`,
      };
    }

    try {
      const stat = fs.statSync(repoPath);
      if (!stat.isDirectory()) {
        return {
          executionId,
          status: 'FAILED',
          error: `Project repository path is not a directory: ${repoPath}`,
        };
      }
    } catch (err: any) {
      return {
        executionId,
        status: 'FAILED',
        error: `Cannot access project repository directory: ${err.message}`,
      };
    }

    // 3. Security Policy: Validate project root path
    const rootPolicy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!rootPolicy.allowed) {
      return {
        executionId,
        status: 'FAILED',
        error: `Project repository path violates security policy: ${rootPolicy.reason}`,
      };
    }

    // 4. Security Policy: Validate and canonicalize all context file paths
    for (const contextFile of request.contextFiles) {
      const canonicalTarget = path.normalize(path.resolve(repoPath, contextFile));
      const filePolicy = PolicyService.evaluatePathAccess(canonicalTarget, repoPath, false);
      if (!filePolicy.allowed) {
        return {
          executionId,
          status: 'FAILED',
          error: `Context file "${contextFile}" violates security policy: ${filePolicy.reason}`,
        };
      }
    }

    // 5. Build prompt and CLI arguments
    const prompt = this.buildPrompt(request);
    const args = this.buildExecutionArgs(request, prompt);

    // 6. Execute through ProcessRunner with durable ownership and safe minimal environment
    const processResult = await ProcessRunner.execute({
      executable: this.executable,
      args,
      cwd: repoPath,
      timeoutMs: this.timeoutMs,
      env: this.env,
      allowShell: false,
      repo: this.repo,
      artifactStore: this.artifactStore,
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: request.attemptId ?? null,
      stdin: this.useStdin ? prompt : undefined,
    });

    // 7. Map cancellation truthfully
    if (processResult.cancelled || processResult.errorCode === 'CANCELLED') {
      return {
        executionId: processResult.executionId,
        status: 'CANCELLED',
        errorCode: 'CANCELLED',
        rawResponse: processResult.stdout,
        error: 'Execution was cancelled.',
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
    }

    // 8. Map timeout / output limit / nonzero process exit truthfully
    if (processResult.timedOut || processResult.errorCode === 'TIMEOUT') {
      return {
        executionId: processResult.executionId,
        status: 'FAILED',
        errorCode: 'TIMEOUT',
        rawResponse: processResult.stdout,
        error: `Process timed out after ${this.timeoutMs}ms.`,
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
    }

    if (processResult.outputLimitExceeded || processResult.errorCode === 'OUTPUT_LIMIT_EXCEEDED') {
      return {
        executionId: processResult.executionId,
        status: 'FAILED',
        errorCode: 'OUTPUT_LIMIT_EXCEEDED',
        rawResponse: processResult.stdout,
        error: 'Process output limit exceeded.',
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
    }

    if (processResult.errorCode === 'PROCESS_LAUNCH_FAILED') {
      return {
        executionId: processResult.executionId,
        status: 'FAILED',
        errorCode: 'PROCESS_LAUNCH_FAILED',
        rawResponse: processResult.stdout,
        error: processResult.stderr || 'Failed to launch process.',
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
    }

    if (processResult.exitCode !== 0) {
      return {
        executionId: processResult.executionId,
        status: 'FAILED',
        errorCode: 'NONZERO_EXIT',
        rawResponse: processResult.stdout,
        error: processResult.stderr || `Process exited with code ${processResult.exitCode}`,
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
    }

    // 9. Protocol validation: Process exit 0 alone is NOT task completion
    const parseResult = ProtocolParser.parse(processResult.stdout);

    if (parseResult.success && parseResult.data?.type === 'coder.v1') {
      return {
        executionId: processResult.executionId,
        status: 'COMPLETED',
        outputProtocol: parseResult.rawJson,
        rawResponse: processResult.stdout,
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
    }

    // Protocol was missing, malformed, or wrong protocol type
    return {
      executionId: processResult.executionId,
      status: 'FAILED',
      errorCode: 'PROTOCOL_INVALID',
      rawResponse: processResult.stdout,
      error: `PROTOCOL_INVALID: Process completed with exit code 0, but stdout did not contain a valid CoderReport protocol payload (${parseResult.error || 'protocol missing'}).`,
      stdoutEvidenceId: processResult.stdoutEvidenceId,
      stderrEvidenceId: processResult.stderrEvidenceId,
    };
  }

  public async cancel(executionId: string): Promise<void> {
    ProcessRunner.cancel(executionId);
  }
}
