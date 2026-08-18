import { Capability, ProviderHealthStatus, ProviderAdapterType, QuotaSource } from '../types/domain';

export interface QuotaSnapshotInfo {
  remaining: number | null;
  total: number | null;
  unit: string;
  source: QuotaSource;
  confidence: number;
  resetAt: string | null;
}

export interface AgentExecutionRequest {
  taskId: string;
  projectId: string;
  instructions: string[];
  contextFiles: string[];
  attemptId?: string | null;
}

export interface AgentExecutionResult {
  executionId: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'AWAITING_OWNER';
  outputProtocol?: string;
  rawResponse?: string;
  error?: string;
  stdoutEvidenceId?: string | null;
  stderrEvidenceId?: string | null;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  adapterType: ProviderAdapterType;
  getCapabilities(): Promise<Capability[]>;
  getHealth(): Promise<ProviderHealthStatus>;
  getQuota(): Promise<QuotaSnapshotInfo>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  cancel(executionId: string): Promise<void>;
}
