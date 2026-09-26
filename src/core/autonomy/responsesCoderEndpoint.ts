import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
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
  isEndpointEligible,
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

export const CoderBundleJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'protocol_version',
    'task_id',
    'authorization_id',
    'source_head',
    'allowed_paths',
    'proposed_edits',
    'summary',
  ],
  properties: {
    protocol_version: {
      type: 'string',
      enum: ['coderbundle.v1'],
    },
    task_id: {
      type: 'string',
    },
    authorization_id: {
      type: 'string',
    },
    source_head: {
      type: 'string',
    },
    allowed_paths: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    proposed_edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
          },
          content: {
            type: 'string',
          },
        },
      },
    },
    summary: {
      type: 'string',
    },
  },
} as const;

export const CODER_BUNDLE_JSON_SCHEMA = CoderBundleJsonSchema;

export function parseCoderEditBundle(raw: string): CoderEditBundle {
  const trimmed = raw.trim();

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

function canonicalRelativePath(rawPath: string, field: string): string {
  const slashPath = rawPath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(slashPath) || path.win32.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)) {
    throw new Error(`PATH_TRAVERSAL: Absolute paths are forbidden in ${field}: ${rawPath}`);
  }
  if (slashPath === '..' || slashPath.startsWith('../') || slashPath.includes('/../')) {
    throw new Error(`PATH_TRAVERSAL: Path traversal is forbidden in ${field}: ${rawPath}`);
  }
  const canonical = path.posix.normalize(slashPath);
  if (
    canonical !== slashPath ||
    canonical === '.' ||
    canonical === '..'
  ) {
    throw new Error(`NON_CANONICAL_PATH: ${field} must use one canonical relative path: ${rawPath}`);
  }
  return canonical;
}

function canonicalBoundaryPath(rawPath: string, field: string): string {
  const slashPath = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const canonical = path.posix.normalize(slashPath);
  if (canonical !== slashPath || canonical === '.' || canonical.includes('/../')) {
    throw new Error(`NON_CANONICAL_PATH: ${field} must use one canonical path: ${rawPath}`);
  }
  return canonical;
}

function filesystemPathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
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
  const contextAllowed = context.allowedPaths.map((p) => canonicalRelativePath(p, 'authorized allowed_paths'));
  const bundleAllowed = bundle.allowed_paths.map((p) => canonicalRelativePath(p, 'bundle allowed_paths'));

  if (new Set(bundleAllowed.map(filesystemPathKey)).size !== bundleAllowed.length) {
    throw new Error('CONTRACT_INVALID: Coder edit bundle contains duplicate allowed_paths');
  }
  if (new Set(contextAllowed.map(filesystemPathKey)).size !== contextAllowed.length) {
    throw new Error('CONTRACT_INVALID: Authorized context contains duplicate allowed_paths');
  }

  if (
    bundleAllowed.length !== contextAllowed.length ||
    bundleAllowed.some((entry, idx) => filesystemPathKey(entry) !== filesystemPathKey(contextAllowed[idx]))
  ) {
    throw new Error(`UNAUTHORIZED_PATH: Coder edit bundle declared allowed_paths does not match authorized paths exactly`);
  }

  const forbidden = (context.forbiddenPaths ?? ['.git']).map((entry) => canonicalBoundaryPath(entry, 'forbidden_paths'));
  const seenEditPaths = new Set<string>();

  for (const edit of bundle.proposed_edits) {
    if (typeof edit.content !== 'string') {
      throw new Error(`CONTRACT_INVALID: Proposed edit content must be a string: ${edit.path}`);
    }

    const normPath = canonicalRelativePath(edit.path, 'proposed_edits.path');
    const editKey = filesystemPathKey(normPath);

    // Reject duplicate edit paths
    if (seenEditPaths.has(editKey)) {
      throw new Error(`CONTRACT_INVALID: Duplicate edit path in proposed_edits: ${edit.path}`);
    }
    seenEditPaths.add(editKey);

    // Check forbidden paths FIRST so explicitly forbidden paths like .git are classified as FORBIDDEN_PATH
    const isForbidden = forbidden.some((entry) => isPathContainedInBoundary(normPath, entry));
    if (isForbidden) {
      throw new Error(`FORBIDDEN_PATH: Proposed edit path is in forbidden paths: ${edit.path}`);
    }

    // Check containment in allowed paths
    const isAllowed = contextAllowed.some((entry) => isPathContainedInBoundary(normPath, entry));
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

  // A routed edit is writable only after Git independently proves the exact
  // source HEAD. Missing Git, a non-repository worktree, malformed output, and
  // process errors all fail closed before filesystem mutation.
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolvedWorktree,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (gitHead.error || gitHead.status !== 0) {
    throw new Error('SOURCE_HEAD_UNVERIFIED: Unable to establish the authorized worktree Git HEAD');
  }
  const currentHead = gitHead.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(currentHead)) {
    throw new Error('SOURCE_HEAD_UNVERIFIED: Git returned an invalid HEAD');
  }
  if (currentHead !== bundle.source_head.toLowerCase()) {
    throw new Error(`STALE_SOURCE_HEAD: Current Git HEAD (${currentHead}) does not match bundle source HEAD (${bundle.source_head})`);
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
    const normPath = canonicalRelativePath(edit.path, 'proposed_edits.path');
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
    const normPath = canonicalRelativePath(edit.path, 'proposed_edits.path');
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

export interface CoderResourceBinding {
  resourceId: string;
  providerId: string;
  providerAccountId: string | null;
  adapterType: 'MANUAL_BRIDGE' | 'LOCAL_CLI' | 'API' | 'MOCK';
  providerEnabled: boolean;
  resourceEnabled: boolean;
  resourceHealth: string;
  capabilities: string[];
  accountEnabled?: boolean | null;
  accountHealth?: string | null;
  accountCooldownUntil?: string | null;
}

function bindingMatches(auth: ExecutionAuthorization, binding?: CoderResourceBinding | null): boolean {
  if (!binding) return false;
  if (binding.resourceId !== auth.selected_resource_id || binding.providerId !== auth.selected_provider_id) return false;
  if (binding.providerAccountId !== (auth.selected_account_id ?? null)) return false;
  return true;
}

function bindingIsAvailable(binding: CoderResourceBinding): boolean {
  if (!binding.providerEnabled || !binding.resourceEnabled) return false;
  if (!binding.capabilities.includes('CODING')) return false;
  if (!['AVAILABLE', 'LOW_QUOTA'].includes(binding.resourceHealth)) return false;
  if (binding.accountEnabled === false) return false;
  if (binding.accountHealth && !['AVAILABLE', 'LOW_QUOTA'].includes(binding.accountHealth)) return false;
  if (binding.accountCooldownUntil && Date.parse(binding.accountCooldownUntil) > Date.now()) return false;
  return true;
}

export function isOmniRouteAuthorization(
  auth: ExecutionAuthorization,
  binding?: CoderResourceBinding | null,
  endpoint?: ProviderEndpointConfig | null,
): boolean {
  return !!endpoint && endpoint.resource_id === auth.selected_resource_id && bindingMatches(auth, binding);
}

export interface AgyCoderIdentity {
  providerId: string;
  resourceId: string;
}

export function isAgyAuthorization(
  auth: ExecutionAuthorization,
  binding?: CoderResourceBinding | null,
  identity?: AgyCoderIdentity | null,
): boolean {
  return !!identity &&
    auth.selected_provider_id === identity.providerId &&
    auth.selected_resource_id === identity.resourceId &&
    bindingMatches(auth, binding) &&
    binding?.adapterType === 'LOCAL_CLI';
}

export type CoderProviderSelection =
  | { provider: 'OMNIROUTE'; error?: never }
  | { provider: 'AGY'; error?: never }
  | { provider: 'NONE'; error: string };

export function resolveCoderProvider(
  auth?: ExecutionAuthorization | null,
  binding?: CoderResourceBinding | null,
  endpoint?: ProviderEndpointConfig | null,
  agyIdentity?: AgyCoderIdentity | null,
): CoderProviderSelection {
  if (!auth) {
    return { provider: 'NONE', error: 'AUTHORIZATION_MISSING: ExecutionAuthorization required for coder execution' };
  }
  const isOmni = isOmniRouteAuthorization(auth, binding, endpoint);
  const isAgy = isAgyAuthorization(auth, binding, agyIdentity);
  if (isOmni && isAgy) {
    return {
      provider: 'NONE',
      error: `AUTHORIZATION_AMBIGUOUS: ExecutionAuthorization has conflicting provider selection (${auth.selected_provider_id}/${auth.selected_resource_id})`,
    };
  }
  if (!bindingMatches(auth, binding)) {
    return {
      provider: 'NONE',
      error: `AUTHORIZATION_RESOURCE_BINDING_INVALID: ExecutionAuthorization does not match a registered provider resource (${auth.selected_provider_id}/${auth.selected_resource_id})`,
    };
  }
  if (!bindingIsAvailable(binding!)) {
    return {
      provider: 'NONE',
      error: `AUTHORIZED_CODER_UNAVAILABLE: Selected coder resource is disabled, unhealthy, cooled down, or lacks CODING capability (${auth.selected_provider_id}/${auth.selected_resource_id})`,
    };
  }
  if (isOmni) {
    if (binding!.adapterType !== 'API') {
      return {
        provider: 'NONE',
        error: `AUTHORIZATION_RESOURCE_BINDING_INVALID: Selected OmniRoute resource is not registered to the API adapter (${auth.selected_resource_id})`,
      };
    }
    if (!endpoint || !isEndpointEligible(endpoint)) {
      return {
        provider: 'NONE',
        error: `AUTHORIZED_CODER_UNAVAILABLE: Selected OmniRoute endpoint is unavailable or under cooldown (${auth.selected_resource_id})`,
      };
    }
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

interface AuthorizedSourceFile {
  path: string;
  content: string;
}

function collectAuthorizedSourceContext(order: WorkOrder): AuthorizedSourceFile[] {
  const worktree = path.resolve(order.worktree);
  const forbidden = order.forbidden_paths;
  const candidates = [...new Set([...order.context_files, ...order.allowed_paths])];
  const files: string[] = [];
  const add = (absolute: string) => {
    const relative = path.relative(worktree, absolute).replace(/\\/g, '/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('SOURCE_CONTEXT_PATH_INVALID: authorized source escaped the worktree');
    }
    if (forbidden.some((entry) => isPathContainedInBoundary(relative, entry))) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`SOURCE_CONTEXT_PATH_INVALID: symlink source is forbidden: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) add(path.join(absolute, child));
    } else if (stat.isFile()) {
      files.push(relative);
    }
  };

  for (const candidate of candidates) {
    const relative = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
      throw new Error(`SOURCE_CONTEXT_PATH_INVALID: ${candidate}`);
    }
    const absolute = path.resolve(worktree, relative);
    assertPathContained(absolute, worktree);
    if (fs.existsSync(absolute)) add(absolute);
  }

  const unique = [...new Set(files)].sort();
  if (unique.length > 64) throw new Error('SOURCE_CONTEXT_LIMIT_EXCEEDED: more than 64 authorized source files');
  let totalBytes = 0;
  return unique.map((relative) => {
    const absolute = path.resolve(worktree, relative);
    const buffer = fs.readFileSync(absolute);
    totalBytes += buffer.byteLength;
    if (totalBytes > 512 * 1024) throw new Error('SOURCE_CONTEXT_LIMIT_EXCEEDED: authorized source exceeds 512 KiB');
    if (buffer.includes(0)) throw new Error(`SOURCE_CONTEXT_BINARY_UNSUPPORTED: ${relative}`);
    return { path: relative, content: buffer.toString('utf8') };
  });
}

export interface CoderDoctorResult {
  run: ProviderRun;
  compatible: boolean;
  healthState: ProviderEndpointHealthState;
  bundle?: CoderEditBundle;
  error?: string;
}

export class ResponsesCoderEndpointTransport implements CoderEndpointTransport {
  private readonly fetchImpl: FetchLike;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: ResponsesEndpointTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.environment = options.environment ?? process.env;
  }

  private redactContractDiagnostic(configInput: ProviderEndpointConfig, error: unknown): string {
    const config = parseProviderEndpointConfig(configInput);
    const envName = referencedEnvironmentName(config.auth_source);
    const authValue = envName ? this.environment[envName] : undefined;
    return redactEndpointDiagnostics(
      error instanceof Error ? error.message : String(error),
      authValue,
      config.base_url,
    );
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
    void config;
    void request;
    // Generic ProviderAdapter execution does not carry the durable task,
    // authorization, source HEAD, and path scope needed for coderbundle.v1.
    // Routed coding is therefore available only through executeWorkOrder,
    // where the Supervisor validates and applies the proposal.
    return {
      executionId: crypto.randomUUID(),
      status: 'FAILED',
      error: 'STRUCTURED_WORK_ORDER_REQUIRED: routed coder execution requires durable coderbundle.v1 authority',
      errorCode: 'PROTOCOL_INVALID',
    };
  }

  async executeWorkOrder(
    configInput: ProviderEndpointConfig,
    order: WorkOrder,
    authorizationId: string,
  ): Promise<{ run: ProviderRun; bundle?: CoderEditBundle }> {
    let sourceFiles: AuthorizedSourceFile[];
    try {
      sourceFiles = collectAuthorizedSourceContext(order);
    } catch (error) {
      const message = sanitizeAutonomyText(error instanceof Error ? error.message : String(error));
      return { run: failedRun('CONTRACT_INVALID', message, Date.now()) };
    }
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
        authorized_source_files: sourceFiles,
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
      const msg = this.redactContractDiagnostic(configInput, error);
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
      validateCoderEditBundle(bundle, {
        taskId: dummyTask,
        authorizationId: dummyAuth,
        sourceHead: dummySha,
        allowedPaths: ['doctor-probe.txt'],
        forbiddenPaths: ['.git'],
      });
      if (bundle.proposed_edits.length === 0) throw new Error('ROUTE_CONTRACT_INVALID: probe returned no proposed edits');
      return {
        run: result.run,
        compatible: true,
        healthState: 'AVAILABLE',
        bundle,
      };
    } catch (error) {
      const msg = this.redactContractDiagnostic(configInput, error);
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
        body: JSON.stringify({
          model: config.model_or_route,
          input: prompt,
          text: {
            format: {
              type: 'json_schema',
              name: 'coder_edit_bundle',
              strict: true,
              schema: CoderBundleJsonSchema,
            },
          },
          store: false,
        }),
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
      if (response.status === 402 || (!response.ok && /insufficient[_ -]?quota|capacity.*exhaust|spend.?limit/i.test(safeRaw))) {
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
