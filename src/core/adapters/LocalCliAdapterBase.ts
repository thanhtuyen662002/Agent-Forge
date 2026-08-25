import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  ProviderAdapter,
  QuotaSnapshotInfo,
  AgentExecutionRequest,
  AgentExecutionResult,
  RuntimeErrorCode,
} from './ProviderAdapter';
import { Capability, ProviderHealthStatus, ProviderAdapterType } from '../types/domain';
import { Repository } from '../database/repositories';
import { ArtifactStore } from '../services/ArtifactStore';
import { ProcessRunner, ProcessRunResult } from '../services/ProcessRunner';
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
  private activeExecutions = new Map<string, { cancelRequested: boolean; processStarted: boolean }>();

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

  protected resolveExecutionEnvironment(_request?: AgentExecutionRequest): Record<string, string> | undefined {
    return this.env;
  }

  protected getAllowedEnvironmentOverrideKeys(_request?: AgentExecutionRequest): string[] {
    return [];
  }

  protected extractProtocolText(_request: AgentExecutionRequest, rawStdout: string): string | null {
    return rawStdout;
  }

  protected classifyProviderProcessFailure(
    _request: AgentExecutionRequest,
    _result: ProcessRunResult
  ): { errorCode: RuntimeErrorCode; error: string } | null {
    return null;
  }

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
        env: this.env,
        allowedEnvKeys: this.getAllowedEnvironmentOverrideKeys(),
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
    const isScheduled = !!request.runtimeBinding?.executionId;
    const executionId = request.runtimeBinding?.executionId ?? crypto.randomUUID();

    if (isScheduled) {
      if (this.activeExecutions.has(executionId)) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'PROCESS_LAUNCH_FAILED',
          error: `LOCAL_CLI_EXECUTION_ALREADY_ACTIVE: Canonical execution ID "${executionId}" is already active in LocalCliAdapterBase.`,
        };
      }
      this.activeExecutions.set(executionId, { cancelRequested: false, processStarted: false });
    }

    try {
      // 1. Mandatory Repository Dependency Gate: Fail closed immediately if repo is absent (no spawn, no process.cwd fallback)
      if (!this.repo) {
        return {
          executionId,
          status: 'FAILED',
          error: 'PROVIDER_REPOSITORY_NOT_CONFIGURED: Local CLI adapter requires a configured Repository to resolve durable project working directory.',
        };
      }

      // 2. Resolve execution root directory (Scheduled Workspace or Legacy Project Repository Path)
      let executionRoot: string;
      const workspace = request.runtimeBinding?.workspace;

      if (workspace) {
        // Defense-in-depth structural validation of ProviderDispatch-produced workspace binding
        if (
          !workspace.workingDirectory ||
          typeof workspace.workingDirectory !== 'string' ||
          !path.isAbsolute(workspace.workingDirectory)
        ) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: workingDirectory must be an absolute path (received "${workspace?.workingDirectory}").`,
          };
        }
        if (!workspace.sourceSha || typeof workspace.sourceSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(workspace.sourceSha)) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: sourceSha must be a 40-character hexadecimal string (received "${workspace?.sourceSha}").`,
          };
        }
        if (!workspace.workerSlotId || typeof workspace.workerSlotId !== 'string' || workspace.workerSlotId.trim() === '') {
          return {
            executionId,
            status: 'FAILED',
            error: 'INVALID_WORKSPACE_BINDING: workerSlotId must be a non-empty string.',
          };
        }
        if (!workspace.ownershipDigest || typeof workspace.ownershipDigest !== 'string' || workspace.ownershipDigest.trim() === '') {
          return {
            executionId,
            status: 'FAILED',
            error: 'INVALID_WORKSPACE_BINDING: ownershipDigest must be a non-empty string.',
          };
        }

        const wsPath = path.normalize(path.resolve(workspace.workingDirectory));
        if (!fs.existsSync(wsPath)) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: Workspace working directory does not exist: ${wsPath}`,
          };
        }
        try {
          const wsStat = fs.statSync(wsPath);
          if (!wsStat.isDirectory()) {
            return {
              executionId,
              status: 'FAILED',
              error: `INVALID_WORKSPACE_BINDING: Workspace working directory is not a directory: ${wsPath}`,
            };
          }
        } catch (err: any) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: Cannot access workspace working directory: ${err.message}`,
          };
        }
        executionRoot = wsPath;
      } else {
        // Legacy path resolution from durable Project database entity
        const project = this.repo.getProject(request.projectId);
        if (!project) {
          return {
            executionId,
            status: 'FAILED',
            error: `PROJECT_NOT_FOUND: Project "${request.projectId}" not found in database.`,
          };
        }

        if (!project.repository_path || typeof project.repository_path !== 'string') {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_PROJECT_REPOSITORY_PATH: Project "${request.projectId}" does not have a valid repository_path configured.`,
          };
        }

        const repoPath = path.normalize(path.resolve(project.repository_path));
        if (!fs.existsSync(repoPath)) {
          return {
            executionId,
            status: 'FAILED',
            error: `REPOSITORY_PATH_NOT_FOUND: Configured project repository path does not exist on disk: ${repoPath}`,
          };
        }
        try {
          const stat = fs.statSync(repoPath);
          if (!stat.isDirectory()) {
            return {
              executionId,
              status: 'FAILED',
              error: `REPOSITORY_PATH_NOT_DIRECTORY: Configured project repository path is not a directory: ${repoPath}`,
            };
          }
        } catch (err: any) {
          return {
            executionId,
            status: 'FAILED',
            error: `REPOSITORY_PATH_ACCESS_ERROR: Cannot access configured project repository path: ${err.message}`,
          };
        }
        executionRoot = repoPath;
      }

      // 3. Mandatory PolicyService Evaluation Gate for Working Directory Access
      const workingDirPolicy = PolicyService.evaluatePathAccess(executionRoot, executionRoot, false);
      if (!workingDirPolicy.allowed) {
        return {
          executionId,
          status: 'FAILED',
          error: `SECURITY_POLICY_VIOLATION: Execution root directory access denied: ${workingDirPolicy.reason} (${workingDirPolicy.decision})`,
        };
      }

      // 4. Validate Context Files (must be strictly inside executionRoot, no path traversal)
      for (const contextFile of request.contextFiles) {
        const canonicalTarget = path.normalize(path.resolve(executionRoot, contextFile));
        const filePolicy = PolicyService.evaluatePathAccess(canonicalTarget, executionRoot, false);
        if (!filePolicy.allowed) {
          return {
            executionId,
            status: 'FAILED',
            error: `SECURITY_POLICY_VIOLATION: Context file "${contextFile}" violates security policy: ${filePolicy.reason} (${filePolicy.decision})`,
          };
        }
      }

      // 5. Build prompt and CLI arguments
      const prompt = this.buildPrompt(request);
      const args = this.buildExecutionArgs(request, prompt);
      const executionEnv = this.resolveExecutionEnvironment(request);
      const allowedEnvKeys = this.getAllowedEnvironmentOverrideKeys(request);

      // 5b. Pre-spawn cancellation check
      const control = isScheduled ? this.activeExecutions.get(executionId) : undefined;
      if (control?.cancelRequested) {
        return {
          executionId,
          status: 'CANCELLED',
          errorCode: 'CANCELLED',
          error: 'Execution was cancelled before process spawn.',
        };
      }

      if (control) {
        control.processStarted = true;
      }

      // 6. Execute through ProcessRunner with durable ownership and safe minimal environment
      const processResult = await ProcessRunner.execute({
        executable: this.executable,
        args,
        cwd: executionRoot,
        timeoutMs: this.timeoutMs,
        env: executionEnv,
        allowedEnvKeys,
        allowShell: false,
        repo: this.repo,
        artifactStore: this.artifactStore,
        projectId: request.projectId,
        taskId: request.taskId,
        attemptId: request.attemptId ?? null,
        stdin: this.useStdin ? prompt : undefined,
        executionId: isScheduled ? executionId : undefined,
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
        const refinedFailure = this.classifyProviderProcessFailure(request, processResult);
        if (refinedFailure) {
          return {
            executionId: processResult.executionId,
            status: 'FAILED',
            errorCode: refinedFailure.errorCode,
            rawResponse: processResult.stdout,
            error: refinedFailure.error,
            stdoutEvidenceId: processResult.stdoutEvidenceId,
            stderrEvidenceId: processResult.stderrEvidenceId,
          };
        }

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
      const protocolText = this.extractProtocolText(request, processResult.stdout);

      if (protocolText === null) {
        return {
          executionId: processResult.executionId,
          status: 'FAILED',
          errorCode: 'PROTOCOL_INVALID',
          rawResponse: processResult.stdout,
          error: 'PROTOCOL_INVALID: Process completed with exit code 0, but output extractor did not produce a valid protocol payload.',
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      const parseResult = ProtocolParser.parse(protocolText);

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
        error: `PROTOCOL_INVALID: Process completed with exit code 0, but payload did not contain a valid CoderReport protocol (${parseResult.error || 'protocol missing or invalid type'}).`,
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
    } finally {
      if (isScheduled) {
        this.activeExecutions.delete(executionId);
      }
    }
  }

  public async cancel(executionId: string): Promise<void> {
    const control = this.activeExecutions.get(executionId);
    if (control) {
      control.cancelRequested = true;
      if (control.processStarted) {
        ProcessRunner.cancel(executionId);
      }
      return;
    }
    ProcessRunner.cancel(executionId);
  }
}
