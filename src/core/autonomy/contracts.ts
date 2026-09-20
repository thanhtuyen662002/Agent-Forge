import { z } from 'zod';

const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/i, 'must be a 40-character Git SHA');
const NonEmptyString = z.string().trim().min(1);

export const WorkOrderSchema = z.object({
  protocol_version: z.literal('workorder.v1'),
  task_id: NonEmptyString,
  issue_number: z.number().int().positive().nullable(),
  worker_id: NonEmptyString,
  objective: NonEmptyString,
  base_sha: ShaSchema,
  branch: NonEmptyString,
  worktree: NonEmptyString,
  dependencies: z.array(NonEmptyString),
  allowed_paths: z.array(NonEmptyString),
  forbidden_paths: z.array(NonEmptyString),
  acceptance_criteria: z.array(NonEmptyString).min(1),
  required_tests: z.array(NonEmptyString),
  context_files: z.array(NonEmptyString),
  constraints: z.array(NonEmptyString),
  attempt: z.number().int().positive(),
  lease_epoch: z.number().int().positive(),
});

export type WorkOrder = z.infer<typeof WorkOrderSchema>;

export const SelfHostTaskSchema = z.object({
  task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  objective: NonEmptyString,
  base_sha: ShaSchema,
  allowed_paths: z.array(NonEmptyString).min(1),
  required_tests: z.array(NonEmptyString).min(1),
  acceptance_criteria: z.array(NonEmptyString).min(1),
  context_files: z.array(NonEmptyString).default([]),
  constraints: z.array(NonEmptyString).default([]),
});
export type SelfHostTask = z.infer<typeof SelfHostTaskSchema>;

export function parseWorkOrder(raw: string): WorkOrder {
  const candidates = [raw.trim(), ...raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && 'item' in parsed) {
        const item = (parsed as { item?: { type?: unknown; text?: unknown } }).item;
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          const nested = WorkOrderSchema.safeParse(JSON.parse(item.text));
          if (nested.success) return nested.data;
        }
      }
      const result = WorkOrderSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Prose and non-final JSONL events are ignored.
    }
  }
  throw new Error('CONTRACT_INVALID: manager output did not contain a valid workorder.v1 object');
}

export const WorkerResultSchema = z.object({
  protocol_version: z.literal('workerresult.v1'),
  task_id: NonEmptyString,
  worker_id: NonEmptyString,
  attempt: z.number().int().positive(),
  status: z.enum(['COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'FAILED']),
  summary: NonEmptyString,
  changed_files: z.array(NonEmptyString),
  commands_run: z.array(NonEmptyString),
  tests: z.array(NonEmptyString),
  known_risks: z.array(NonEmptyString),
  blockers: z.array(NonEmptyString),
});

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const ManagerReviewSchema = z.object({
  protocol_version: z.literal('managerreview.v1'),
  verdict: z.enum(['PASS', 'REPAIR', 'BLOCKED']),
  reviewed_head_sha: ShaSchema,
  findings: z.array(z.object({
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    title: NonEmptyString,
    description: NonEmptyString,
    file_path: NonEmptyString.nullable().optional(),
    line_number: z.number().int().positive().nullable().optional(),
  })),
  required_actions: z.array(NonEmptyString),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  notes: z.string().default(''),
});

export type ManagerReview = z.infer<typeof ManagerReviewSchema>;

export const AutonomyStateSchema = z.enum([
  'READY', 'LEASED', 'IMPLEMENTING', 'LOCAL_VERIFY', 'MANAGER_REVIEW', 'REPAIR',
  'PR_OPEN', 'CI_WAIT', 'MERGE_READY', 'MERGED', 'BLOCKED', 'FAILED',
]);
export type AutonomyState = z.infer<typeof AutonomyStateSchema>;

export const ProviderFailureSchema = z.enum([
  'SUCCESSFUL_PROCESS_EXIT', 'FAILED_PROCESS_EXIT', 'TIMEOUT', 'CANCELLED',
  'AUTH_ERROR', 'QUOTA_OR_RATE_LIMIT', 'PROCESS_NOT_FOUND', 'CONTRACT_INVALID',
]);
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;

export interface AutonomousTaskSpec {
  taskId: string;
  issueNumber?: number | null;
  objective: string;
  baseSha: string;
  branch: string;
  worktree: string;
  dependencies?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  acceptanceCriteria: string[];
  requiredTests?: string[];
  contextFiles?: string[];
  constraints?: string[];
  workerId: string;
  attempt?: number;
  leaseEpoch?: number;
}

export interface GitEvidence {
  headSha: string;
  snapshotSha?: string;
  status: string;
  changedFiles: string[];
  diff: string;
  tests: Array<{ command: string; exitCode: number; stdout: string; stderr: string; durationMs: number }>;
}

export function createWorkOrder(spec: AutonomousTaskSpec): WorkOrder {
  return WorkOrderSchema.parse({
    protocol_version: 'workorder.v1',
    task_id: spec.taskId,
    issue_number: spec.issueNumber ?? null,
    worker_id: spec.workerId,
    objective: spec.objective,
    base_sha: spec.baseSha.toLowerCase(),
    branch: spec.branch,
    worktree: spec.worktree,
    dependencies: spec.dependencies ?? [],
    allowed_paths: spec.allowedPaths ?? [],
    forbidden_paths: spec.forbiddenPaths ?? [],
    acceptance_criteria: spec.acceptanceCriteria,
    required_tests: spec.requiredTests ?? [],
    context_files: spec.contextFiles ?? [],
    constraints: spec.constraints ?? [],
    attempt: spec.attempt ?? 1,
    lease_epoch: spec.leaseEpoch ?? 1,
  });
}

export function parseWorkerResult(raw: string): WorkerResult | null {
  const candidates = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const result = WorkerResultSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Informational worker output is allowed; no claim is trusted as evidence.
    }
  }
  return null;
}

export function parseManagerReview(raw: string): ManagerReview {
  const candidates = [raw.trim(), ...raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && 'item' in parsed) {
        const item = (parsed as { item?: { type?: unknown; text?: unknown } }).item;
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          const nested = ManagerReviewSchema.safeParse(JSON.parse(item.text));
          if (nested.success) return nested.data;
        }
      }
      const review = ManagerReviewSchema.safeParse(parsed);
      if (review.success) return review.data;
    } catch {
      // Try the next JSON line; prose is never authoritative.
    }
  }
  throw new Error('CONTRACT_INVALID: manager output did not contain a valid managerreview.v1 object');
}

export function sanitizeAutonomyText(text: string, maxBytes = 2 * 1024 * 1024): string {
  const sanitized = String(text ?? '')
    .replace(/(?:gh[pousr]_[A-Za-z0-9_\-]{20,})/g, '[REDACTED_SECRET]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED_SECRET]');
  return Buffer.byteLength(sanitized, 'utf8') <= maxBytes
    ? sanitized
    : `${Buffer.from(sanitized, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[TRUNCATED]`;
}
