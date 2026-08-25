import { Capability, ProviderHealthStatus, ProviderAdapterType, QuotaSource, AccountAuthMode } from '../types/domain';

export type RuntimeErrorCode =
  | 'AUTH_ERROR'
  | 'QUOTA_EXHAUSTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROCESS_LAUNCH_FAILED'
  | 'NONZERO_EXIT'
  | 'PROTOCOL_INVALID'
  | 'UNSUPPORTED_CLIENT'
  | 'RESOURCE_UNAVAILABLE'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'POLICY_DENIAL'
  | 'EXECUTION_FAILED'
  | 'UNKNOWN';

export interface QuotaSnapshotInfo {
  remaining: number | null;
  total: number | null;
  unit: string;
  source: QuotaSource;
  confidence: number;
  resetAt: string | null;
}

export interface RuntimeWorkspaceBinding {
  workerSlotId: string;
  ownershipDigest: string;
  sourceSha: string;
  workingDirectory: string;
}

export interface RuntimeExecutionBinding {
  authorizationId: string;
  routingDecisionId: string;
  assignmentId: string;
  providerId: string;
  accountId: string;
  resourceId: string;
  adapterType: ProviderAdapterType;
  modelName: string;
  accountAuthMode: AccountAuthMode;
  profileRef: string | null;
  executionId?: string;
  workspace?: RuntimeWorkspaceBinding;
}

export interface AgentExecutionRequest {
  taskId: string;
  projectId: string;
  instructions: string[];
  contextFiles: string[];
  attemptId?: string | null;
  runtimeBinding?: RuntimeExecutionBinding;
}

export interface AgentExecutionResult {
  executionId: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'AWAITING_OWNER';
  outputProtocol?: string;
  rawResponse?: string;
  error?: string;
  errorCode?: RuntimeErrorCode | null;
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
