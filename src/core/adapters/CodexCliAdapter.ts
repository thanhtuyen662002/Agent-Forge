import { LocalCliAdapterBase, LocalCliAdapterOptions } from './LocalCliAdapterBase';
import { Capability, ProviderHealthStatus } from '../types/domain';
import { AgentExecutionRequest, AgentExecutionResult } from './ProviderAdapter';
import crypto from 'crypto';

export interface CodexCliAdapterOptions extends LocalCliAdapterOptions {
  contractVerified?: boolean;
}

export class CodexCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-codex-cli';
  public readonly name: string = 'Codex CLI';

  private contractVerified: boolean;

  constructor(options?: CodexCliAdapterOptions) {
    super(options);
    this.contractVerified = options?.contractVerified ?? false;
  }

  protected getDefaultExecutable(): string {
    return 'codex';
  }

  public async getCapabilities(): Promise<Capability[]> {
    return [
      'CODING',
      'FILESYSTEM_EDIT',
      'TEST_EXECUTION',
      'LARGE_CONTEXT',
    ];
  }

  public override async getHealth(): Promise<ProviderHealthStatus> {
    if (!this.contractVerified) {
      return 'OFFLINE';
    }
    return super.getHealth();
  }

  public override async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    // Fail closed immediately without process spawn if CLI contract is unverified on this host
    if (!this.contractVerified) {
      return {
        executionId: crypto.randomUUID(),
        status: 'FAILED',
        error: 'CODEX_CLI_UNAVAILABLE: Codex CLI is not installed or contract is unverified on this host.',
      };
    }

    return super.execute(request);
  }
}
