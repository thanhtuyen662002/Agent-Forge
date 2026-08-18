import { LocalCliAdapterBase, LocalCliAdapterOptions } from './LocalCliAdapterBase';
import { Capability, ProviderHealthStatus } from '../types/domain';
import { AgentExecutionRequest, AgentExecutionResult } from './ProviderAdapter';
import crypto from 'crypto';

export class CodexCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-codex-cli';
  public readonly name: string = 'Codex CLI';

  constructor(options?: LocalCliAdapterOptions) {
    super(options);
  }

  protected getDefaultExecutable(): string {
    return 'codex';
  }

  public async getCapabilities(): Promise<Capability[]> {
    // Zero capabilities advertised while execution contract is unavailable on this host
    return [];
  }

  public override async getHealth(): Promise<ProviderHealthStatus> {
    // Truthfully report OFFLINE on this workstation
    return 'OFFLINE';
  }

  public override async execute(_request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    // Fail closed immediately without spawning child processes
    return {
      executionId: crypto.randomUUID(),
      status: 'FAILED',
      error: 'CODEX_CLI_UNAVAILABLE: Codex CLI is not installed or contract is unverified on this host.',
    };
  }
}
