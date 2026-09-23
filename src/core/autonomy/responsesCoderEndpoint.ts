import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
  RuntimeErrorCode,
} from '../adapters/ProviderAdapter';
import { ExecutionAuthorization } from '../types/domain';
import { assertPathContained } from '../services/ArtifactStore';
import {
  WorkOrder,
  sanitizeAutonomyText,
} from './contracts';
import {
  CoderEndpointTransport,
  ProviderEndpointConfig,
  ProviderEndpointHealthState,
  parseProviderEndpointConfig,
} from './providerEndpoint';
import type { ProviderRun } from './providers';
import {
  endpointUrl,
  failedRun,
  outputText,
  redactValue,
  redactEndpointDiagnostics,
  referencedEnvironmentName,
  responseId,
  ResponsesEndpointTransportOptions,
} from './responsesEndpoint';
import { isPathContainedInBoundary } from './productTaskAdapter';

type FetchLike = typeof fetch;

export const CoderEditFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
}).strict();
export type CoderEditFile = z.infer<typeof CoderEditFileSchema>;

export const CoderEditBundleSchema = z.object({
  protocol_version: z.literal('coderbundle.v1'),
  task_id: z.string().trim().min(1),
  authorization_id: z.string().trim().min(1),
  source_head: z.string().trim().regex(/^[0-9a-f]{40}$/i, 'must be a 40-character Git SHA'),
  allowed_paths: z.array(z.string().trim().min(1)),
  proposed_edits: z.array(CoderEditFileSchema),
  summary: z.string().optional(),
}).strict();
export type CoderEditBundle = z.infer<typeof CoderEditBundleSchema>;

export function parseCoderEditBundle(raw: string): CoderEditBundle {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```') || /```/.test(trimmed)) {
    throw new Error('CONTRACT_INVALID: markdown fences are forbidden in coderbundle.v1');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('CONTRACT_INVALID: coder output did not contain valid JSON');
  }

  const result = CoderEditBundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`CONTRACT_INVALID: coder output did not contain a valid coderbundle.v1 object: ${result.error.message}`);
  }

  return result.data;
}

export interface CoderValidationContext {
  taskId: string;
  authorizationId: string;
  sourceHead: string;
  allowedPaths: string[];
  forbiddenPaths?: string[];
  worktree?: string;
}

export function validateCoderEditBundle(
  bundle: CoderEditBundle,
  context: CoderValidationContext,
): CoderEditBundle {
  if (bundle.task_id !== context.taskId) {
    throw new Error(`CONTRACT_INVALID: Task ID mismatch in coder edit bundle: expected ${context.taskId}, got ${bundle.task_id}`);
  }
  if (bundle.authorization_id !== context.authorizationId) {
    throw new Error(`CONTRACT_INVALID: Authorization ID mismatch in coder edit bundle: expected ${context.authorizationId}, got ${bundle.authorization_id}`);
  }
  if (bundle.source_head.toLowerCase() !== context.sourceHead.toLowerCase()) {
    throw new Error(`STALE_SOURCE_HEAD: Coder edit bundle source HEAD mismatch: expected ${context.sourceHead}, got ${bundle.source_head}`);
  }

  // Require allowed_paths to match the authorized list exactly
  const contextAllowed = context.allowedPaths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));
  const bundleAllowed = bundle.allowed_paths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));

  if (new Set(bundleAllowed).size !== bundleAllowed.length) {
    throw new Error('CONTRACT_INVALID: Coder edit bundle contains duplicate allowed_paths');
  }

  if (
    bundleAllowed.length !== contextAllowed.length ||
    bundleAllowed.some((entry, idx) => entry !== contextAllowed[idx])
  ) {
    throw new Error(`UNAUTHORIZED_PATH: Coder edit bundle declared allowed_paths does not match authorized paths exactly`);
  }

  const forbidden = context.forbiddenPaths ?? ['.git'];
  const seenEditPaths = new Set<string>();

  for (const edit of bundle.proposed_edits) {
    if (typeof edit.content !== 'string') {
      throw new Error(`CONTRACT_INVALID: Proposed edit content must be a string: ${edit.path}`);
    }

    const normPath = edit.path.replace(/\\/g, '/').replace(/^\.\//, '');

    // Reject duplicate edit paths
    if (seenEditPaths.has(normPath)) {
      throw new Error(`CONTRACT_INVALID: Duplicate edit path in proposed_edits: ${edit.path}`);
    }
    seenEditPaths.add(normPath);

    // Check for absolute path or path traversal attempts
    if (path.isAbsolute(edit.path) || path.win32.isAbsolute(edit.path) || normPath.startsWith('/') || /^[a-zA-Z]:/.test(edit.path)) {
      throw new Error(`PATH_TRAVERSAL: Absolute paths are forbidden: ${edit.path}`);
    }
    if (normPath === '..' || normPath.startsWith('../') || normPath.includes('/../')) {
      throw new Error(`PATH_TRAVERSAL: Path traversal outside worktree is forbidden: ${edit.path}`);
    }

    // Check forbidden paths FIRST so explicitly forbidden paths like .git are classified as FORBIDDEN_PATH
    const isForbidden = forbidden.some((entry) => isPathContainedInBoundary(normPath, entry));
    if (isForbidden) {
      throw new Error(`FORBIDDEN_PATH: Proposed edit path is in forbidden paths: ${edit.path}`);
    }

    // Check containment in allowed paths
    const isAllowed = context.allowedPaths.some((entry) => isPathContainedInBoundary(normPath, entry));
    if (!isAllowed) {
      throw new Error(`UNAUTHORIZED_PATH: Proposed edit path is not in allowed paths: ${edit.path}`);
    }

    if (context.worktree) {
      const fullPath = path.resolve(context.worktree, normPath);
      try {
        assertPathContained(fullPath, context.worktree);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`PATH_TRAVERSAL: ${msg}`);
      }
    }
  }

  return bundle;
}

export function applyCoderEditBundle(
  worktree: string,
  bundle: CoderEditBundle,
  context?: Omit<CoderValidationContext, 'worktree'>,
): { changedFiles: string[] } {
  const resolvedWorktree = path.resolve(worktree);
  if (!fs.existsSync(resolvedWorktree) || !fs.statSync(resolvedWorktree).isDirectory()) {
    throw new Error(`WORKTREE_NOT_FOUND: Authorized worktree does not exist: ${worktree}`);
  }

  // Independently verify that authorized worktree's Git HEAD matches bundle.source_head if in a git repository
  try {
    const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolvedWorktree, encoding: 'utf8', windowsHide: true, shell: false });
    if (gitHead.status === 0) {
      const currentHead = gitHead.stdout.trim().toLowerCase();
      if (/^[0-9a-f]{40}$/i.test(currentHead) && currentHead !== bundle.source_head.toLowerCase()) {
        throw new Error(`STALE_SOURCE_HEAD: Current Git HEAD (${currentHead}) does not match bundle source HEAD (${bundle.source_head})`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('STALE_SOURCE_HEAD')) {
      throw err;
    }
  }

  if (context) {
    validateCoderEditBundle(bundle, { ...context, worktree: resolvedWorktree });
  }

  const realWorktree = fs.realpathSync(resolvedWorktree);
  const isRootEqual = (candidate: string, root: string) =>
    process.platform === 'win32'
      ? candidate.toLowerCase() === root.toLowerCase()
      : candidate === root;

  // Complete security preflight across all proposed edits before modifying filesystem
  for (const edit of bundle.proposed_edits) {
    const normPath = edit.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const dest = path.resolve(resolvedWorktree, normPath);
    try {
      assertPathContained(dest, resolvedWorktree);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`PATH_TRAVERSAL: ${msg}`);
    }

    // Harden against symlinks and junction escapes in existing path components
    let checkDir = path.dirname(dest);
    while (checkDir.length >= resolvedWorktree.length) {
      if (fs.existsSync(checkDir)) {
        const lstat = fs.lstatSync(checkDir);
        if (lstat.isSymbolicLink()) {
          throw new Error(`PATH_TRAVERSAL: Path component is a symlink: ${edit.path}`);
        }
        const realDir = fs.realpathSync(checkDir);
        if (!isRootEqual(realDir, realWorktree)) {
          try {
            assertPathContained(realDir, realWorktree);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`PATH_TRAVERSAL: ${msg}`);
          }
        }
      }
      const parent = path.dirname(checkDir);
      if (parent === checkDir) break;
      checkDir = parent;
    }

    if (fs.existsSync(dest)) {
      const lstat = fs.lstatSync(dest);
      if (lstat.isSymbolicLink()) {
        throw new Error(`PATH_TRAVERSAL: Target path is a symlink: ${edit.path}`);
      }
      const realDest = fs.realpathSync(dest);
      try {
        assertPathContained(realDest, realWorktree);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`PATH_TRAVERSAL: ${msg}`);
      }
    }
  }

  // Preflight passed cleanly for all proposed edits. Apply edits to filesystem.
  const changedFiles: string[] = [];
  for (const edit of bundle.proposed_edits) {
    const normPath = edit.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const dest = path.resolve(resolvedWorktree, normPath);

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, edit.content, 'utf8');

    const realWritten = fs.realpathSync(dest);
    try {
      assertPathContained(realWritten, realWorktree);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`PATH_TRAVERSAL: ${msg}`);
    }

    changedFiles.push(normPath);
  }

  return { changedFiles };
}

export function isOmniRouteCoder(resourceOrProviderId: string): boolean {
  const norm = resourceOrProviderId.toLowerCase();
  return norm.includes('omniroute') || norm === 'external_router' || norm === 'coder-omniroute';
}

export function isAgyCoder(resourceOrProviderId: string): boolean {
  const norm = resourceOrProviderId.toLowerCase();
  return norm.includes('antigravity') || norm.includes('agy') || norm === 'local_cli';
}

export function isOmniRouteAuthorization(auth: ExecutionAuthorization): boolean {
  return isOmniRouteCoder(auth.selected_resource_id) || isOmniRouteCoder(auth.selected_provider_id);
}

export function isAgyAuthorization(auth: ExecutionAuthorization): boolean {
  return isAgyCoder(auth.selected_resource_id) || isAgyCoder(auth.selected_provider_id);
}

export type CoderProviderSelection =
  | { provider: 'OMNIROUTE'; error?: never }
  | { provider: 'AGY'; error?: never }
  | { provider: 'NONE'; error: string };

export function resolveCoderProvider(auth?: ExecutionAuthorization | null): CoderProviderSelection {
  if (!auth) {
    return { provider: 'NONE', error: 'AUTHORIZATION_MISSING: ExecutionAuthorization required for coder execution' };
  }
  const isOmni = isOmniRouteAuthorization(auth);
  const isAgy = isAgyAuthorization(auth);
  if (isOmni && isAgy) {
    return {
      provider: 'NONE',
      error: `AUTHORIZATION_AMBIGUOUS: ExecutionAuthorization has conflicting provider selection (${auth.selected_provider_id}/${auth.selected_resource_id})`,
    };
  }
  if (isOmni) {
    return { provider: 'OMNIROUTE' };
  }
  if (isAgy) {
    return { provider: 'AGY' };
  }
  return {
    provider: 'NONE',
    error: `AUTHORIZATION_UNKNOWN_PROVIDER: ExecutionAuthorization selects unrecognized coder provider (${auth.selected_provider_id}/${auth.selected_resource_id})`,
  };
}

export interface CoderDoctorResult {
  run: ProviderRun;
  compatible: boolean;
  healthState: ProviderEndpointHealthState;
  bundle?: CoderEditBundle;
  error?: string;
}

function mapStatusToErrorCode(status: ProviderRun['status']): RuntimeErrorCode {
  switch (status) {
    case 'AUTH_ERROR': return 'AUTH_ERROR';
    case 'QUOTA_OR_RATE_LIMIT': return 'QUOTA_EXHAUSTED';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'CANCELLED': return 'CANCELLED';
    case 'PROCESS_NOT_FOUND': return 'RESOURCE_UNAVAILABLE';
    case 'CONTRACT_INVALID': return 'PROTOCOL_INVALID';
    default: return 'EXECUTION_FAILED';
  }
}

export class ResponsesCoderEndpointTransport implements CoderEndpointTransport {
  private readonly fetchImpl: FetchLike;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: ResponsesEndpointTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.environment = options.environment ?? process.env;
  }

  async getHealth(config: ProviderEndpointConfig): Promise<ProviderEndpointHealthState> {
    const probe = await this.contract(config);
    return probe.healthState;
  }

  async getQuota(_config: ProviderEndpointConfig): Promise<QuotaSnapshotInfo> {
    return {
      remaining: null,
      total: null,
      unit: 'ROUTE_REQUESTS',
      source: 'UNKNOWN',
      confidence: 0,
      resetAt: null,
    };
  }

  async cancel(_config: ProviderEndpointConfig, _executionId: string): Promise<void> {
    // Router execution is non-persistent and cancelled by closing connection
  }

  async execute(config: ProviderEndpointConfig, request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const prompt = request.instructions.join('\n');
    const result = await this.request(config, prompt);
    if (result.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !result.text) {
      return {
        executionId: result.run.executionId || crypto.randomUUID(),
        status: 'FAILED',
        error: result.run.error ?? result.run.stderr,
        errorCode: mapStatusToErrorCode(result.run.status),
      };
    }
    return {
      executionId: result.run.executionId || crypto.randomUUID(),
      status: 'COMPLETED',
      outputProtocol: 'workerresult.v1',
      rawResponse: result.text,
    };
  }

  async executeWorkOrder(
    configInput: ProviderEndpointConfig,
    order: WorkOrder,
    authorizationId: string,
  ): Promise<{ run: ProviderRun; bundle?: CoderEditBundle }> {
    const prompt = [
      'You are the Agent Forge routed coder. You return proposed edits only; you do not execute tests or edit Git.',
      'Return exactly one JSON object matching coderbundle.v1 and no markdown.',
      'Every proposed edit must specify a relative path within allowed_paths and complete replacement file contents.',
      'Preserve task_id, authorization_id, source_head, and allowed_paths exactly as specified below.',
      JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: order.task_id,
        authorization_id: authorizationId,
        source_head: order.base_sha,
        allowed_paths: order.allowed_paths,
        forbidden_paths: order.forbidden_paths,
        objective: order.objective,
        acceptance_criteria: order.acceptance_criteria,
        context_files: order.context_files,
        constraints: order.constraints,
      }),
    ].join('\n');

    const result = await this.request(configInput, prompt);
    if (result.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !result.text) {
      return { run: result.run };
    }

    try {
      const bundle = parseCoderEditBundle(result.text);
      validateCoderEditBundle(bundle, {
        taskId: order.task_id,
        authorizationId,
        sourceHead: order.base_sha,
        allowedPaths: order.allowed_paths,
        forbiddenPaths: order.forbidden_paths,
        worktree: order.worktree,
      });
      return { run: result.run, bundle };
    } catch (error) {
      const msg = sanitizeAutonomyText(error instanceof Error ? error.message : String(error));
      return {
        run: {
          ...result.run,
          status: 'CONTRACT_INVALID',
          error: msg,
          stderr: msg,
        },
      };
    }
  }

  async contract(configInput: ProviderEndpointConfig): Promise<CoderDoctorResult> {
    const dummyTask = 'doctor-probe';
    const dummyAuth = 'auth-doctor-probe';
    const dummySha = '0'.repeat(40);
    const probePrompt = [
      'You are the Agent Forge coder contract probe.',
      'Return exactly one JSON object matching coderbundle.v1. Do not edit any files.',
      JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: dummyTask,
        authorization_id: dummyAuth,
        source_head: dummySha,
        allowed_paths: ['doctor-probe.txt'],
        proposed_edits: [{ path: 'doctor-probe.txt', content: 'CODER_OK' }],
      }),
    ].join('\n');

    const result = await this.request(configInput, probePrompt);
    if (result.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !result.text) {
      return {
        run: result.run,
        compatible: false,
        healthState: result.healthState,
        error: result.run.error ?? result.run.stderr,
      };
    }

    try {
      const bundle = parseCoderEditBundle(result.text);
      if (
        bundle.task_id !== dummyTask ||
        bundle.authorization_id !== dummyAuth ||
        bundle.source_head !== dummySha ||
        !Array.isArray(bundle.proposed_edits) ||
        bundle.proposed_edits.length === 0
      ) {
        return {
          run: { ...result.run, status: 'CONTRACT_INVALID', stderr: 'ROUTE_CONTRACT_INVALID: probe identity mismatch' },
          compatible: false,
          healthState: 'CONTRACT_INVALID',
          error: 'Probe response failed identity bindings',
        };
      }
      return {
        run: result.run,
        compatible: true,
        healthState: 'AVAILABLE',
        bundle,
      };
    } catch (error) {
      const msg = sanitizeAutonomyText(error instanceof Error ? error.message : String(error));
      return {
        run: {
          ...result.run,
          status: 'CONTRACT_INVALID',
          error: msg,
          stderr: msg,
        },
        compatible: false,
        healthState: 'CONTRACT_INVALID',
        error: msg,
      };
    }
  }

  private async request(
    configInput: ProviderEndpointConfig,
    prompt: string,
  ): Promise<{ run: ProviderRun; text?: string; healthState: ProviderEndpointHealthState }> {
    const started = Date.now();
    const config = parseProviderEndpointConfig(configInput);
    if (!config.base_url) {
      return {
        run: failedRun('CONTRACT_INVALID', 'PROVIDER_ENDPOINT_BASE_URL_MISSING', started),
        healthState: 'CONTRACT_INVALID',
      };
    }
    const envName = referencedEnvironmentName(config.auth_source);
    if (!envName) {
      return {
        run: failedRun('AUTH_ERROR', 'PROVIDER_ENDPOINT_AUTH_SOURCE_UNSUPPORTED', started),
        healthState: 'AUTH_ERROR',
      };
    }
    const authValue = this.environment[envName];
    if (!authValue) {
      return {
        run: failedRun('AUTH_ERROR', `PROVIDER_ENDPOINT_AUTH_ENV_MISSING: ${envName}`, started),
        healthState: 'AUTH_ERROR',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
    try {
      const response = await this.fetchImpl(endpointUrl(config.base_url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [config.auth_header_name]: authValue,
        },
        body: JSON.stringify({ model: config.model_or_route, input: prompt, store: false }),
        signal: controller.signal,
      });

      const raw = await response.text();
      const safeRaw = redactValue(raw, authValue, config.base_url);

      if (response.status === 401 || response.status === 403) {
        return {
          run: failedRun('AUTH_ERROR', `ROUTE_AUTH_ERROR HTTP ${response.status}: ${safeRaw}`, started),
          healthState: 'AUTH_ERROR',
        };
      }
      if (response.status === 402 || /insufficient[_ -]?quota|capacity.*exhaust|spend.?limit/i.test(safeRaw)) {
        return {
          run: failedRun('QUOTA_OR_RATE_LIMIT', `ROUTE_CAPACITY_EXHAUSTED HTTP ${response.status}: ${safeRaw}`, started),
          healthState: 'CAPACITY_EXHAUSTED',
        };
      }
      if (response.status === 429) {
        return {
          run: failedRun('QUOTA_OR_RATE_LIMIT', `ROUTE_RATE_LIMITED HTTP 429: ${safeRaw}`, started),
          healthState: 'RATE_LIMITED',
        };
      }
      if (!response.ok) {
        return {
          run: failedRun('FAILED_PROCESS_EXIT', `ROUTE_SERVER_FAILURE HTTP ${response.status}: ${safeRaw}`, started),
          healthState: 'DEGRADED',
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return {
          run: failedRun('CONTRACT_INVALID', 'ROUTE_CONTRACT_INVALID: response was not JSON', started),
          healthState: 'CONTRACT_INVALID',
        };
      }

      const text = outputText(payload);
      if (!text) {
        return {
          run: failedRun('CONTRACT_INVALID', 'ROUTE_CONTRACT_INVALID: no Responses output text', started),
          healthState: 'CONTRACT_INVALID',
        };
      }

      const safeText = redactValue(text, authValue, config.base_url);
      return {
        text,
        healthState: 'AVAILABLE',
        run: {
          status: 'SUCCESSFUL_PROCESS_EXIT',
          exitCode: 0,
          executionId: responseId(payload),
          stdout: safeText,
          stderr: '',
          durationMs: Date.now() - started,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          run: failedRun('TIMEOUT', 'ROUTE_TIMEOUT', started),
          healthState: 'OFFLINE',
        };
      }
      return {
        run: failedRun(
          'PROCESS_NOT_FOUND',
          `ROUTE_OFFLINE: ${redactValue(error instanceof Error ? error.message : String(error), authValue, config.base_url)}`,
          started,
        ),
        healthState: 'OFFLINE',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
