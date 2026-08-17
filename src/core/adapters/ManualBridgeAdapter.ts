import { ProviderAdapter, QuotaSnapshotInfo, AgentExecutionRequest, AgentExecutionResult } from './ProviderAdapter';
import { Capability, ProviderHealthStatus } from '../types/domain';

export class ManualBridgeAdapter implements ProviderAdapter {
  public id: string = 'prov-manual-bridge';
  public name: string = 'Owner Manual Bridge';

  public async getCapabilities(): Promise<Capability[]> {
    return [
      'PLANNING',
      'CODING',
      'REVIEW',
      'SECURITY_REVIEW',
      'LARGE_CONTEXT',
      'FILESYSTEM_EDIT',
      'TEST_EXECUTION',
    ];
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    // In Manual Bridge mode, health is unknown until owner provides reports
    return 'UNKNOWN';
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN',
      confidence: 0.0,
      resetAt: null,
    };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    // In manual bridge mode, execution is performed via Owner clipboard copy/paste
    return {
      executionId: `manual-exec-${Date.now()}`,
      status: 'COMPLETED',
      outputProtocol: 'Awaiting Owner Manual Relay via Manual Bridge',
    };
  }

  public async cancel(executionId: string): Promise<void> {
    // Manual operations cannot be killed via OS signals
  }
}
