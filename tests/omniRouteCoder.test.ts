import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AutonomyStore } from '../src/core/autonomy/store';
import { AutonomySupervisor } from '../src/core/autonomy/supervisor';
import { createWorkOrder } from '../src/core/autonomy/contracts';
import {
  ProviderEndpointConfig,
  parseProviderEndpointConfig,
} from '../src/core/autonomy/providerEndpoint';
import {
  loadOmniRouteEndpointFromEnvironment,
} from '../src/core/autonomy/responsesEndpoint';
import {
  CoderEditBundle,
  ResponsesCoderEndpointTransport,
  applyCoderEditBundle,
  isAgyAuthorization,
  isOmniRouteAuthorization,
  parseCoderEditBundle,
  resolveCoderProvider,
  validateCoderEditBundle,
} from '../src/core/autonomy/responsesCoderEndpoint';
import { doctorOmniRouteCoder } from '../src/electron/autonomyCli';
import { AntigravityAdapter } from '../src/core/autonomy/providers';
import { ExecutionAuthorization } from '../src/core/types/domain';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import {
  CanonicalExecutionPayload,
  computePayloadHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { renderCommand } from '../src/core/autonomy/productTaskAdapter';

let shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const secretToken = 'sk-router-secret-token-9876543210';

function coderEndpointConfig(timeoutMs = 1_000): ProviderEndpointConfig {
  return parseProviderEndpointConfig({
    resource_id: 'coder-omniroute',
    role: 'CODER',
    adapter_type: 'EXTERNAL_ROUTER',
    base_url: 'https://router.example.test/v1',
    allow_insecure_http: false,
    model_or_route: 'coder-production-model',
    auth_source: 'env://TEST_CODER_AUTH',
    auth_header_name: 'X-Company-Auth',
    priority: 280,
    timeout_ms: timeoutMs,
    enabled: true,
    health_state: 'AVAILABLE',
    cooldown_state: { active: false, until: null, reason: null },
    capabilities: ['CODING'],
  });
}

function responsePayload(text: string): string {
  return JSON.stringify({
    id: 'resp-fake-coder',
    output: [{ content: [{ type: 'output_text', text }] }],
  });
}

function coderBinding(
  providerId: string,
  resourceId: string,
  adapterType: 'LOCAL_CLI' | 'API' | 'MOCK',
  providerAccountId: string | null = null,
) {
  return {
    providerId,
    resourceId,
    providerAccountId,
    adapterType,
    providerEnabled: true,
    resourceEnabled: true,
    resourceHealth: 'AVAILABLE',
    capabilities: ['CODING'],
    accountEnabled: providerAccountId ? true : null,
    accountHealth: providerAccountId ? 'AVAILABLE' : null,
    accountCooldownUntil: null,
  };
}

describe('OmniRoute Coder Transport & Structured Edits', () => {
  let tempDir: string;
  let worktreeDir: string;
  let controlDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniroute-coder-test-'));
    controlDir = path.join(tempDir, 'control');
    fs.mkdirSync(controlDir, { recursive: true });
    worktreeDir = path.join(tempDir, 'worktree');
    fs.mkdirSync(worktreeDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: worktreeDir, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'agent-forge-tests@example.invalid'], { cwd: worktreeDir, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Agent Forge Tests'], { cwd: worktreeDir, windowsHide: true });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'test base'], { cwd: worktreeDir, windowsHide: true });
    shaA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreeDir, encoding: 'utf8', windowsHide: true }).trim();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  describe('1. Valid edit application & path fencing', () => {
    it('strictly applies complete replacement contents inside authorized worktree', () => {
      const targetFile = path.join(worktreeDir, 'src', 'calculator.ts');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, 'export function add(a: number, b: number) { return a - b; }\n', 'utf8');

      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-100',
        authorization_id: 'auth-100',
        source_head: shaA,
        allowed_paths: ['src/calculator.ts'],
        proposed_edits: [
          {
            path: 'src/calculator.ts',
            content: 'export function add(a: number, b: number): number { return a + b; }\n',
          },
        ],
      };

      const result = applyCoderEditBundle(worktreeDir, bundle, {
        taskId: 'TSK-100',
        authorizationId: 'auth-100',
        sourceHead: shaA,
        allowedPaths: ['src/calculator.ts'],
      });

      expect(result.changedFiles).toEqual(['src/calculator.ts']);
      expect(fs.readFileSync(targetFile, 'utf8')).toBe(
        'export function add(a: number, b: number): number { return a + b; }\n'
      );
    });

    it('creates missing directories when applying edits in nested authorized paths', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-101',
        authorization_id: 'auth-101',
        source_head: shaA,
        allowed_paths: ['src/sub/nested/file.ts'],
        proposed_edits: [
          {
            path: 'src/sub/nested/file.ts',
            content: 'export const value = 42;\n',
          },
        ],
      };

      const result = applyCoderEditBundle(worktreeDir, bundle, {
        taskId: 'TSK-101',
        authorizationId: 'auth-101',
        sourceHead: shaA,
        allowedPaths: ['src/sub/nested/file.ts'],
      });

      expect(result.changedFiles).toEqual(['src/sub/nested/file.ts']);
      expect(fs.readFileSync(path.join(worktreeDir, 'src', 'sub', 'nested', 'file.ts'), 'utf8')).toBe(
        'export const value = 42;\n'
      );
    });

    it('rejects edit when target is a symlink or resolves outside worktree via symlink', () => {
      const outsideFile = path.join(tempDir, 'outside-secret.txt');
      fs.writeFileSync(outsideFile, 'secret', 'utf8');

      const symlinkFile = path.join(worktreeDir, 'symlink.txt');
      try {
        fs.symlinkSync(outsideFile, symlinkFile);
      } catch {
        // Symlinks on Windows may require administrative privileges; if unsupported, skip
        return;
      }

      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-SYM-1',
        authorization_id: 'auth-sym-1',
        source_head: shaA,
        allowed_paths: ['symlink.txt'],
        proposed_edits: [
          {
            path: 'symlink.txt',
            content: 'overwritten secret',
          },
        ],
      };

      expect(() => {
        applyCoderEditBundle(worktreeDir, bundle, {
          taskId: 'TSK-SYM-1',
          authorizationId: 'auth-sym-1',
          sourceHead: shaA,
          allowedPaths: ['symlink.txt'],
        });
      }).toThrow(/PATH_TRAVERSAL/i);

      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('secret');
    });
  });

  describe('2. Traversal and unauthorized path rejection', () => {
    it('rejects relative path traversal escaping worktree', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-200',
        authorization_id: 'auth-200',
        source_head: shaA,
        allowed_paths: ['src'],
        proposed_edits: [
          {
            path: '../outside.txt',
            content: 'malicious payload',
          },
        ],
      };

      expect(() => {
        applyCoderEditBundle(worktreeDir, bundle, {
          taskId: 'TSK-200',
          authorizationId: 'auth-200',
          sourceHead: shaA,
          allowedPaths: ['src'],
        });
      }).toThrow(/PATH_TRAVERSAL/i);

      expect(fs.existsSync(path.join(tempDir, 'outside.txt'))).toBe(false);
    });

    it('rejects absolute paths', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-201',
        authorization_id: 'auth-201',
        source_head: shaA,
        allowed_paths: ['src'],
        proposed_edits: [
          {
            path: '/etc/passwd',
            content: 'root:x:0:0::/root:/bin/bash',
          },
        ],
      };

      expect(() => {
        validateCoderEditBundle(bundle, {
          taskId: 'TSK-201',
          authorizationId: 'auth-201',
          sourceHead: shaA,
          allowedPaths: ['src'],
        });
      }).toThrow(/PATH_TRAVERSAL/i);
    });

    it('rejects paths outside allowed paths boundary', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-202',
        authorization_id: 'auth-202',
        source_head: shaA,
        allowed_paths: ['src/allowed.ts'],
        proposed_edits: [
          {
            path: 'src/forbidden.ts',
            content: 'unauthorized',
          },
        ],
      };

      expect(() => {
        validateCoderEditBundle(bundle, {
          taskId: 'TSK-202',
          authorizationId: 'auth-202',
          sourceHead: shaA,
          allowedPaths: ['src/allowed.ts'],
        });
      }).toThrow(/UNAUTHORIZED_PATH/i);
    });

    it('rejects paths matching forbidden paths', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-203',
        authorization_id: 'auth-203',
        source_head: shaA,
        allowed_paths: ['src'],
        proposed_edits: [
          {
            path: '.git/config',
            content: '[core]\nrepositoryformatversion = 0',
          },
        ],
      };

      expect(() => {
        validateCoderEditBundle(bundle, {
          taskId: 'TSK-203',
          authorizationId: 'auth-203',
          sourceHead: shaA,
          allowedPaths: ['src'],
          forbiddenPaths: ['.git'],
        });
      }).toThrow(/FORBIDDEN_PATH/i);
    });

    it('rejects bundle when declared allowed_paths does not match authorized allowed_paths exactly', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-204',
        authorization_id: 'auth-204',
        source_head: shaA,
        allowed_paths: ['src/a.ts', 'src/extra.ts'],
        proposed_edits: [{ path: 'src/a.ts', content: 'test' }],
      };

      expect(() => {
        validateCoderEditBundle(bundle, {
          taskId: 'TSK-204',
          authorizationId: 'auth-204',
          sourceHead: shaA,
          allowedPaths: ['src/a.ts'],
        });
      }).toThrow(/UNAUTHORIZED_PATH/i);
    });

    it('rejects proposed_edits with duplicate edit paths', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-205',
        authorization_id: 'auth-205',
        source_head: shaA,
        allowed_paths: ['src/a.ts'],
        proposed_edits: [
          { path: 'src/a.ts', content: 'version 1' },
          { path: 'src/a.ts', content: 'version 2' },
        ],
      };

      expect(() => {
        validateCoderEditBundle(bundle, {
          taskId: 'TSK-205',
          authorizationId: 'auth-205',
          sourceHead: shaA,
          allowedPaths: ['src/a.ts'],
        });
      }).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects aliased edit paths that resolve to the same destination before writing', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-206',
        authorization_id: 'auth-206',
        source_head: shaA,
        allowed_paths: ['src/a.ts'],
        proposed_edits: [
          { path: 'src/a.ts', content: 'version 1' },
          { path: 'src//a.ts', content: 'version 2' },
        ],
      };
      expect(() => applyCoderEditBundle(worktreeDir, bundle, {
        taskId: 'TSK-206',
        authorizationId: 'auth-206',
        sourceHead: shaA,
        allowedPaths: ['src/a.ts'],
      })).toThrow(/NON_CANONICAL_PATH|Duplicate edit path/i);
      expect(fs.existsSync(path.join(worktreeDir, 'src', 'a.ts'))).toBe(false);
    });
  });

  describe('3. Stale source HEAD rejection', () => {
    it('rejects edit bundle when source_head differs from current repository HEAD', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-300',
        authorization_id: 'auth-300',
        source_head: shaB, // stale SHA
        allowed_paths: ['src/app.ts'],
        proposed_edits: [{ path: 'src/app.ts', content: 'new content' }],
      };

      expect(() => {
        validateCoderEditBundle(bundle, {
          taskId: 'TSK-300',
          authorizationId: 'auth-300',
          sourceHead: shaA, // expected current SHA
          allowedPaths: ['src/app.ts'],
        });
      }).toThrow(/STALE_SOURCE_HEAD/i);
    });

    it('executeWorkOrder returns CONTRACT_INVALID on stale source HEAD', async () => {
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => new Response(responsePayload(JSON.stringify({
          protocol_version: 'coderbundle.v1',
          task_id: 'TSK-301',
          authorization_id: 'auth-301',
          source_head: shaB, // stale
          allowed_paths: ['src/app.ts'],
          proposed_edits: [{ path: 'src/app.ts', content: 'console.log("hello");' }],
        })), { status: 200 }),
      });

      const order = createWorkOrder({
        taskId: 'TSK-301',
        workerId: 'coder-omniroute',
        objective: 'test stale head',
        baseSha: shaA,
        branch: 'test',
        worktree: worktreeDir,
        allowedPaths: ['src/app.ts'],
        acceptanceCriteria: ['tests pass'],
        requiredTests: ['test'],
      });

      const result = await transport.executeWorkOrder(coderEndpointConfig(), order, 'auth-301');
      expect(result.run.status).toBe('CONTRACT_INVALID');
      expect(result.run.error).toContain('STALE_SOURCE_HEAD');
      expect(result.bundle).toBeUndefined();
    });

    it('fails closed before writing when the worktree Git HEAD cannot be established', () => {
      const nonRepository = path.join(tempDir, 'not-a-repository');
      fs.mkdirSync(nonRepository, { recursive: true });
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-302',
        authorization_id: 'auth-302',
        source_head: shaA,
        allowed_paths: ['src/app.ts'],
        proposed_edits: [{ path: 'src/app.ts', content: 'forbidden write' }],
      };
      expect(() => applyCoderEditBundle(nonRepository, bundle, {
        taskId: 'TSK-302',
        authorizationId: 'auth-302',
        sourceHead: shaA,
        allowedPaths: ['src/app.ts'],
      })).toThrow(/SOURCE_HEAD_UNVERIFIED/);
      expect(fs.existsSync(path.join(nonRepository, 'src', 'app.ts'))).toBe(false);
    });

    it('supplies bounded authorized source contents to the routed coder', async () => {
      const sourcePath = path.join(worktreeDir, 'src', 'app.ts');
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, 'export const answer = 41;\n', 'utf8');
      let observedInput = '';
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async (_url, init) => {
          observedInput = String(JSON.parse(String(init?.body)).input);
          return new Response(responsePayload(JSON.stringify({
            protocol_version: 'coderbundle.v1',
            task_id: 'TSK-303',
            authorization_id: 'auth-303',
            source_head: shaA,
            allowed_paths: ['src/app.ts'],
            proposed_edits: [{ path: 'src/app.ts', content: 'export const answer = 42;\n' }],
          })), { status: 200 });
        },
      });
      const order = createWorkOrder({
        taskId: 'TSK-303',
        workerId: 'coder-omniroute',
        objective: 'use authorized source context',
        baseSha: shaA,
        branch: 'test',
        worktree: worktreeDir,
        allowedPaths: ['src/app.ts'],
        acceptanceCriteria: ['updates answer'],
        requiredTests: ['test'],
      });
      const result = await transport.executeWorkOrder(coderEndpointConfig(), order, 'auth-303');
      expect(result.run.status).toBe('SUCCESSFUL_PROCESS_EXIT');
      expect(observedInput).toContain('authorized_source_files');
      expect(observedInput).toContain('export const answer = 41;');
    });
  });

  describe('4. Malformed response rejection', () => {
    it('rejects markdown code fences', () => {
      const wrapped = '```json\n' + JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-400',
        authorization_id: 'auth-400',
        source_head: shaA,
        allowed_paths: ['src/app.ts'],
        proposed_edits: [{ path: 'src/app.ts', content: 'hello' }],
      }) + '\n```';
      expect(() => parseCoderEditBundle(wrapped)).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects unknown fields in coderbundle.v1', () => {
      const payload = JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-401',
        authorization_id: 'auth-401',
        source_head: shaA,
        allowed_paths: ['src/app.ts'],
        proposed_edits: [{ path: 'src/app.ts', content: 'hello' }],
        unknown_extension_field: 'illegal',
      });
      expect(() => parseCoderEditBundle(payload)).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects alias fields and does not auto-map them', () => {
      const payload = JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-402',
        authorization_id: 'auth-402',
        source_head_sha: shaA,
        allowed_paths: ['src/app.ts'],
        edits: [{ path: 'src/app.ts', content: 'hello' }],
      });
      expect(() => parseCoderEditBundle(payload)).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects alternate protocol names like codereditbundle.v1', () => {
      const payload = JSON.stringify({
        protocol_version: 'codereditbundle.v1',
        task_id: 'TSK-403',
        authorization_id: 'auth-403',
        source_head: shaA,
        allowed_paths: ['src/app.ts'],
        proposed_edits: [{ path: 'src/app.ts', content: 'hello' }],
      });
      expect(() => parseCoderEditBundle(payload)).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects trailing line prose with embedded JSON', () => {
      const text = 'Here is the response:\n' + JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-404',
        authorization_id: 'auth-404',
        source_head: shaA,
        allowed_paths: ['src/app.ts'],
        proposed_edits: [{ path: 'src/app.ts', content: 'hello' }],
      }) + '\nHope this helps!';
      expect(() => parseCoderEditBundle(text)).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects non-JSON router responses', () => {
      expect(() => parseCoderEditBundle('This is not JSON at all')).toThrow(/CONTRACT_INVALID/i);
      expect(() => parseCoderEditBundle('{malformed_json')).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects missing required bundle fields', () => {
      expect(() => parseCoderEditBundle(JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: 'TSK-400',
        // missing authorization_id, source_head, allowed_paths, proposed_edits
      }))).toThrow(/CONTRACT_INVALID/i);
    });

    it('rejects Task ID and Authorization ID mismatches', () => {
      const bundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: 'WRONG-TASK',
        authorization_id: 'auth-400',
        source_head: shaA,
        allowed_paths: ['src/app.ts'],
        proposed_edits: [{ path: 'src/app.ts', content: 'test' }],
      };

      expect(() => {
        validateCoderEditBundle(bundle, {
          taskId: 'EXPECTED-TASK',
          authorizationId: 'auth-400',
          sourceHead: shaA,
          allowedPaths: ['src/app.ts'],
        });
      }).toThrow(/Task ID mismatch/i);

      const bundle2: CoderEditBundle = {
        ...bundle,
        task_id: 'EXPECTED-TASK',
        authorization_id: 'WRONG-AUTH',
      };

      expect(() => {
        validateCoderEditBundle(bundle2, {
          taskId: 'EXPECTED-TASK',
          authorizationId: 'EXPECTED-AUTH',
          sourceHead: shaA,
          allowedPaths: ['src/app.ts'],
        });
      }).toThrow(/Authorization ID mismatch/i);
    });
  });

  describe('5. Durable coder selection & No silent AGY fallback', () => {
    it('correctly classifies OmniRoute vs AGY ExecutionAuthorization', () => {
      const omniAuth = {
        selected_provider_id: 'omniroute',
        selected_resource_id: 'coder-omniroute',
      } as ExecutionAuthorization;

      const agyAuth = {
        selected_provider_id: 'antigravity-cli',
        selected_resource_id: 'agy-01',
      } as ExecutionAuthorization;

      const omniBinding = coderBinding('omniroute', 'coder-omniroute', 'API');
      const agyBinding = coderBinding('antigravity-cli', 'agy-01', 'LOCAL_CLI');
      const agyIdentity = { providerId: 'antigravity-cli', resourceId: 'agy-01' };
      expect(isOmniRouteAuthorization(omniAuth, omniBinding, coderEndpointConfig())).toBe(true);
      expect(isAgyAuthorization(omniAuth, omniBinding, agyIdentity)).toBe(false);

      expect(isOmniRouteAuthorization(agyAuth, agyBinding, coderEndpointConfig())).toBe(false);
      expect(isAgyAuthorization(agyAuth, agyBinding, agyIdentity)).toBe(true);
    });

    it('does not select an authorized OmniRoute endpoint during cooldown', () => {
      const auth = {
        selected_provider_id: 'provider-omniroute',
        selected_resource_id: 'coder-omniroute',
      } as ExecutionAuthorization;
      const endpoint = coderEndpointConfig();
      endpoint.cooldown_state = {
        active: true,
        until: new Date(Date.now() + 60_000).toISOString(),
        reason: 'rate limited',
      };
      const selection = resolveCoderProvider(
        auth,
        coderBinding('provider-omniroute', 'coder-omniroute', 'API'),
        endpoint,
      );
      expect(selection.provider).toBe('NONE');
      expect(selection.error).toContain('AUTHORIZED_CODER_UNAVAILABLE');
    });

    it('rejects an account mismatch before either coder can be selected', () => {
      const selection = resolveCoderProvider(
        {
          selected_provider_id: 'provider-omniroute',
          selected_resource_id: 'coder-omniroute',
          selected_account_id: 'account-wrong',
        } as ExecutionAuthorization,
        coderBinding('provider-omniroute', 'coder-omniroute', 'API', 'account-authorized'),
        coderEndpointConfig(),
      );
      expect(selection.provider).toBe('NONE');
      expect(selection.error).toContain('AUTHORIZATION_RESOURCE_BINDING_INVALID');
    });

    it('does not treat an unrelated LOCAL_CLI resource as the registered AGY fallback', () => {
      const selection = resolveCoderProvider(
        {
          selected_provider_id: 'provider-unrelated-cli',
          selected_resource_id: 'resource-unrelated-cli',
        } as ExecutionAuthorization,
        coderBinding('provider-unrelated-cli', 'resource-unrelated-cli', 'LOCAL_CLI'),
        coderEndpointConfig(),
        { providerId: 'prov-antigravity-cli', resourceId: 'res-antigravity-cli-coder' },
      );
      expect(selection.provider).toBe('NONE');
      expect(selection.error).toContain('AUTHORIZATION_UNKNOWN_PROVIDER');
    });

    it('fails closed when OmniRoute fails and does not silently fall back to AGY under old authorization', async () => {
      const db = new Database(':memory:');
      MigrationRunner.run(db);
      const store = new AutonomyStore(db);
      const repo: any = new Repository(db);

      const now = new Date().toISOString();
      repo.createProject({
        id: 'PROJ-OMNI',
        name: 'Project Omni',
        repository_path: worktreeDir,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
      });

      repo.createTask({
        id: 'TSK-OMNI-FAIL',
        project_id: 'PROJ-OMNI',
        title: 'Task with OmniRoute Coder',
        description: 'omniroute fail test',
        state: 'APPROVED',
        priority: 'HIGH',
        risk: 'LOW',
        revision_count: 0,
        max_revisions: 3,
        base_sha: shaA,
        current_sha: shaA,
        progress_cache_percent: 0,
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      });

      repo.createProvider({ id: 'provider-omniroute', name: 'OmniRoute', adapter_type: 'API', enabled: true, created_at: now });
      repo.createProviderAccount({
        id: 'account-omni',
        provider_id: 'provider-omniroute',
        label: 'OmniRoute account',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: 'wincred://agentforge/test/omniroute-coder',
        profile_ref: null,
        enabled: true,
        priority: 100,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 2,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: now,
        updated_at: now,
      });
      repo.createProviderResource({
        id: 'coder-omniroute',
        provider_id: 'provider-omniroute',
        provider_account_id: 'account-omni',
        model_name: 'coder-production-model',
        health_status: 'AVAILABLE',
        capabilities: ['CODING'],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: now,
      });
      repo.createRoleProfile({
        id: 'role-coder',
        role: 'CODER',
        display_name: 'Coder',
        required_capabilities: ['CODING'],
        preferred_capabilities: [],
        authority_scope: null,
        permissions: ['FILESYSTEM_EDIT'],
        output_protocol: 'coder.v1',
        enabled: true,
        created_at: now,
        updated_at: now,
      });
      repo.createWorkerSlot({
        id: 'slot-omni',
        provider_account_id: 'account-omni',
        provider_resource_id: 'coder-omniroute',
        slot_index: 1,
        status: 'IDLE',
        current_assignment_id: null,
        current_execution_id: null,
        heartbeat_at: null,
        created_at: now,
        updated_at: now,
      });
      repo.createAgentAssignment({
        id: 'assignment-omni',
        project_id: 'PROJ-OMNI',
        task_id: 'TSK-OMNI-FAIL',
        attempt_id: null,
        role_profile_id: 'role-coder',
        agent_profile_id: null,
        selected_provider_id: 'provider-omniroute',
        selected_account_id: 'account-omni',
        selected_resource_id: 'coder-omniroute',
        selected_worker_slot_id: 'slot-omni',
        routing_decision_id: 'route-1',
        preferred_metadata: null,
        status: 'ASSIGNED',
        created_at: now,
        ended_at: null,
      });

      const context = new ContextBuilderService(repo).buildContextSnapshot({
        projectId: 'PROJ-OMNI',
        taskId: 'TSK-OMNI-FAIL',
        assignmentId: 'assignment-omni',
        purpose: 'EXECUTION',
        includeProjectMemory: false,
        includeTaskMemory: false,
        includeLatestCheckpoint: false,
        includeLatestHandoff: false,
      });

      const testCommand = renderCommand({ executable: 'npm', args: ['test'] });
      const canonicalPayload: CanonicalExecutionPayload = {
        projectId: 'PROJ-OMNI',
        taskId: 'TSK-OMNI-FAIL',
        attemptId: null,
        taskTitle: 'Task with OmniRoute Coder',
        taskDescription: 'omniroute fail test',
        acceptanceCriteria: ['pass'],
        constraints: [],
        instructions: ['Implement'],
        contextFiles: [],
        verificationCommands: {
          TEST: { executable: 'npm', args: ['test'] },
          LINT: null,
          BUILD: null,
        },
        managerMessageId: 'msg-1',
        managerPayloadHash: 'hash-1',
        executionScope: {
          branch: 'agent/omni',
          worktree: worktreeDir,
          allowedPaths: ['src'],
          forbiddenPaths: ['.git'],
        },
      };

      repo.recordProtocolMessage(
        'msg-1',
        'ext-msg-1',
        'manager.v1',
        'PROJ-OMNI',
        'TSK-OMNI-FAIL',
        'APPROVED',
        0,
        'hash-1',
        JSON.stringify({ decision: 'EXECUTE', taskId: 'TSK-OMNI-FAIL' }),
        'APPLIED',
      );

      const payloadHash = computePayloadHash(canonicalPayload);

      // Authorization bound specifically to OmniRoute
      repo.createExecutionAuthorization({
        id: 'AUTH-OMNI-1',
        project_id: 'PROJ-OMNI',
        task_id: 'TSK-OMNI-FAIL',
        attempt_id: null,
        task_revision: 0,
        base_sha: shaA,
        repository_head_sha: shaA,
        manager_message_id: 'msg-1',
        manager_payload_hash: 'hash-1',
        routing_decision_id: 'route-1',
        selected_provider_id: 'provider-omniroute',
        selected_account_id: 'account-omni',
        selected_resource_id: 'coder-omniroute',
        instruction_payload_hash: payloadHash,
        context_manifest_hash: context.manifest.manifest_hash,
        canonical_instructions_json: JSON.stringify(canonicalPayload.instructions),
        context_files_json: '[]',
        canonical_payload_json: JSON.stringify(canonicalPayload),
        expected_task_revision: 0,
        status: 'AUTHORIZED',
        created_at: now,
        assignment_id: 'assignment-omni',
        task_ownership_epoch: 1,
        lifecycle_version: 1,
      });

      let agyExecuteCalls = 0;
      const fakeAgy = {
        execute: async () => {
          agyExecuteCalls++;
          return {
            status: 'SUCCESSFUL_PROCESS_EXIT' as const,
            exitCode: 0,
            executionId: 'agy-run',
            stdout: 'AGY OK',
            stderr: '',
            durationMs: 10,
          };
        },
      } as unknown as AntigravityAdapter;

      // Mock OmniRoute coder transport failing with 503 Service Unavailable
      const failingCoderTransport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => new Response('OmniRoute router unavailable', { status: 503 }),
      });

      const supervisor = new AutonomySupervisor({
        store,
        controlRepo: controlDir,
        worktreeRoot: tempDir,
        agy: fakeAgy,
        coderEndpoint: coderEndpointConfig(),
        coderTransport: failingCoderTransport,
        evidence: {
          collect: async () => ({
            headSha: shaA,
            status: '',
            changedFiles: [],
            diff: '',
            tests: [{ command: 'npm test', exitCode: 0, stdout: '', stderr: '', durationMs: 5 }],
          }),
        },
      });

      const order = createWorkOrder({
        taskId: 'TSK-OMNI-FAIL',
        workerId: 'agy-01',
        objective: 'omniroute fail test',
        baseSha: shaA,
        branch: 'agent/omni',
        worktree: worktreeDir,
        allowedPaths: ['src'],
        acceptanceCriteria: ['pass'],
        requiredTests: [testCommand],
      });

      const runResult = await supervisor.run({
        taskId: order.task_id,
        objective: order.objective,
        baseSha: order.base_sha,
        branch: order.branch,
        worktree: order.worktree,
        allowedPaths: order.allowed_paths,
        forbiddenPaths: ['.git'],
        acceptanceCriteria: order.acceptance_criteria,
        requiredTests: order.required_tests,
        workerId: order.worker_id,
      });

      // Product task remains repairable in CODING, but the authorized route
      // fails closed and MUST NOT silently fall back to AGY.
      expect(runResult.accepted).toBe(false);
      expect(runResult.state, runResult.error).toBe('CODING');
      expect(runResult.error).toContain('ROUTE_SERVER_FAILURE');
      expect(agyExecuteCalls).toBe(0); // AGY was NEVER silently invoked!
      db.close();
    });

    it('fails closed when ExecutionAuthorization is missing and never invokes AGY or OmniRoute', async () => {
      const db = new Database(':memory:');
      MigrationRunner.run(db);
      const store = new AutonomyStore(db);
      const repo: any = new Repository(db);

      const now = new Date().toISOString();
      repo.createProject({
        id: 'PROJ-NO-AUTH',
        name: 'Project No Auth',
        repository_path: worktreeDir,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
      });

      repo.createTask({
        id: 'TSK-NO-AUTH',
        project_id: 'PROJ-NO-AUTH',
        title: 'Task without Auth',
        description: 'missing auth',
        state: 'APPROVED',
        priority: 'HIGH',
        risk: 'LOW',
        revision_count: 0,
        max_revisions: 3,
        base_sha: shaA,
        current_sha: shaA,
        progress_cache_percent: 0,
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      });

      let agyCalls = 0;
      let omniCalls = 0;
      const fakeAgy = {
        execute: async () => { agyCalls++; return { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: 'a', stdout: '', stderr: '', durationMs: 1 }; },
      } as unknown as AntigravityAdapter;

      const fakeOmni = {
        executeWorkOrder: async () => { omniCalls++; return { run: { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: 'o', stdout: '', stderr: '', durationMs: 1 } }; },
      } as unknown as ResponsesCoderEndpointTransport;

      const supervisor = new AutonomySupervisor({
        store,
        controlRepo: controlDir,
        worktreeRoot: tempDir,
        agy: fakeAgy,
        coderEndpoint: coderEndpointConfig(),
        coderTransport: fakeOmni,
        evidence: {
          collect: async () => ({
            headSha: shaA,
            status: '',
            changedFiles: [],
            diff: '',
            tests: [{ command: 'npm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
          }),
        },
      });

      const order = createWorkOrder({
        taskId: 'TSK-NO-AUTH',
        workerId: 'agy-01',
        objective: 'missing auth',
        baseSha: shaA,
        branch: 'test',
        worktree: worktreeDir,
        allowedPaths: ['src'],
        acceptanceCriteria: ['pass'],
        requiredTests: ['npm test'],
      });

      const result = await supervisor.run({
        taskId: order.task_id,
        objective: order.objective,
        baseSha: order.base_sha,
        branch: order.branch,
        worktree: order.worktree,
        allowedPaths: order.allowed_paths,
        acceptanceCriteria: order.acceptance_criteria,
        requiredTests: order.required_tests,
        workerId: order.worker_id,
      });

      expect(result.state).toBe('BLOCKED');
      expect(result.error).toContain('AUTHORIZATION_MISSING');
      expect(agyCalls).toBe(0);
      expect(omniCalls).toBe(0);
      db.close();
    });

    it('fails closed when ExecutionAuthorization selects unknown provider and never invokes AGY or OmniRoute', async () => {
      const selection = resolveCoderProvider({
        selected_provider_id: 'unknown-vendor-provider',
        selected_resource_id: 'unknown-vendor-coder',
      } as ExecutionAuthorization, coderBinding('unknown-vendor-provider', 'unknown-vendor-coder', 'MOCK'), coderEndpointConfig());
      expect(selection.provider).toBe('NONE');
      expect(selection.error).toContain('AUTHORIZATION_UNKNOWN_PROVIDER');

      const db = new Database(':memory:');
      MigrationRunner.run(db);
      const store = new AutonomyStore(db);
      const repo: any = new Repository(db);

      const now = new Date().toISOString();
      repo.createProject({
        id: 'PROJ-UNK',
        name: 'Project Unknown',
        repository_path: worktreeDir,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
      });

      repo.createTask({
        id: 'TSK-UNK-AUTH',
        project_id: 'PROJ-UNK',
        title: 'Task with Unknown Provider Auth',
        description: 'unknown auth',
        state: 'APPROVED',
        priority: 'HIGH',
        risk: 'LOW',
        revision_count: 0,
        max_revisions: 3,
        base_sha: shaA,
        current_sha: shaA,
        progress_cache_percent: 0,
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      });

      repo.createProvider({ id: 'unknown-vendor-provider', name: 'Unsupported coder', adapter_type: 'MOCK', enabled: true, created_at: now });
      repo.createProviderResource({
        id: 'unknown-vendor-coder',
        provider_id: 'unknown-vendor-provider',
        provider_account_id: null,
        model_name: 'unsupported',
        health_status: 'AVAILABLE',
        capabilities: ['CODING'],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: now,
      });
      repo.recordProtocolMessage(
        'msg-unk',
        'ext-msg-unk',
        'manager.v1',
        'PROJ-UNK',
        'TSK-UNK-AUTH',
        'APPROVED',
        0,
        'hash-unk',
        JSON.stringify({ decision: 'EXECUTE', taskId: 'TSK-UNK-AUTH' }),
        'APPLIED',
      );

      repo.createExecutionAuthorization({
        id: 'AUTH-UNK-1',
        project_id: 'PROJ-UNK',
        task_id: 'TSK-UNK-AUTH',
        attempt_id: null,
        task_revision: 0,
        base_sha: shaA,
        repository_head_sha: shaA,
        manager_message_id: 'msg-unk',
        manager_payload_hash: 'hash-unk',
        routing_decision_id: 'route-unk',
        selected_provider_id: 'unknown-vendor-provider',
        selected_resource_id: 'unknown-vendor-coder',
        instruction_payload_hash: 'hash-unk-2',
        context_manifest_hash: 'hash-unk-3',
        canonical_instructions_json: '[]',
        context_files_json: '[]',
        canonical_payload_json: null,
        status: 'AUTHORIZED',
        created_at: now,
      });

      let agyCalls = 0;
      let omniCalls = 0;
      const fakeAgy = {
        execute: async () => { agyCalls++; return { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: 'a', stdout: '', stderr: '', durationMs: 1 }; },
      } as unknown as AntigravityAdapter;

      const fakeOmni = {
        executeWorkOrder: async () => { omniCalls++; return { run: { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: 'o', stdout: '', stderr: '', durationMs: 1 } }; },
      } as unknown as ResponsesCoderEndpointTransport;

      const supervisor = new AutonomySupervisor({
        store,
        controlRepo: controlDir,
        worktreeRoot: tempDir,
        agy: fakeAgy,
        coderEndpoint: coderEndpointConfig(),
        coderTransport: fakeOmni,
        evidence: {
          collect: async () => ({
            headSha: shaA,
            status: '',
            changedFiles: [],
            diff: '',
            tests: [{ command: 'npm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
          }),
        },
      });

      const order = createWorkOrder({
        taskId: 'TSK-UNK-AUTH',
        workerId: 'agy-01',
        objective: 'unknown auth',
        baseSha: shaA,
        branch: 'test',
        worktree: worktreeDir,
        allowedPaths: ['src'],
        acceptanceCriteria: ['pass'],
        requiredTests: ['npm test'],
      });

      const result = await supervisor.run({
        taskId: order.task_id,
        objective: order.objective,
        baseSha: order.base_sha,
        branch: order.branch,
        worktree: order.worktree,
        allowedPaths: order.allowed_paths,
        acceptanceCriteria: order.acceptance_criteria,
        requiredTests: order.required_tests,
        workerId: order.worker_id,
      });

      expect(result.state).toBe('BLOCKED');
      expect(result.error).toContain('AUTHORIZATION_UNKNOWN_PROVIDER');
      expect(agyCalls).toBe(0);
      expect(omniCalls).toBe(0);
      db.close();
    });

    it('fails closed when ExecutionAuthorization is ambiguous/conflicting and never invokes AGY or OmniRoute', async () => {
      const conflictingSelection = resolveCoderProvider({
        selected_provider_id: 'provider-omniroute',
        selected_resource_id: 'coder-omniroute',
      } as ExecutionAuthorization, coderBinding('provider-omniroute', 'coder-omniroute', 'LOCAL_CLI'), coderEndpointConfig(), {
        providerId: 'provider-omniroute',
        resourceId: 'coder-omniroute',
      });
      expect(conflictingSelection.provider).toBe('NONE');
      expect(conflictingSelection.error).toContain('AUTHORIZATION_AMBIGUOUS');

      const db = new Database(':memory:');
      MigrationRunner.run(db);
      const store = new AutonomyStore(db);
      const repo: any = new Repository(db);

      const now = new Date().toISOString();
      repo.createProject({
        id: 'PROJ-AMB',
        name: 'Project Ambiguous',
        repository_path: worktreeDir,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
      });

      repo.createTask({
        id: 'TSK-AMB-AUTH',
        project_id: 'PROJ-AMB',
        title: 'Task with Conflicting Provider Auth',
        description: 'ambiguous auth',
        state: 'APPROVED',
        priority: 'HIGH',
        risk: 'LOW',
        revision_count: 0,
        max_revisions: 3,
        base_sha: shaA,
        current_sha: shaA,
        progress_cache_percent: 0,
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      });

      repo.createProvider({ id: 'provider-omniroute', name: 'Conflicting local provider', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
      repo.createProviderResource({
        id: 'coder-omniroute',
        provider_id: 'provider-omniroute',
        provider_account_id: null,
        model_name: 'conflicting-local-coder',
        health_status: 'AVAILABLE',
        capabilities: ['CODING'],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: now,
      });
      repo.recordProtocolMessage(
        'msg-amb',
        'ext-msg-amb',
        'manager.v1',
        'PROJ-AMB',
        'TSK-AMB-AUTH',
        'APPROVED',
        0,
        'hash-amb',
        JSON.stringify({ decision: 'EXECUTE', taskId: 'TSK-AMB-AUTH' }),
        'APPLIED',
      );

      // The configured endpoint and registered adapter disagree about the same resource.
      repo.createExecutionAuthorization({
        id: 'AUTH-AMB-1',
        project_id: 'PROJ-AMB',
        task_id: 'TSK-AMB-AUTH',
        attempt_id: null,
        task_revision: 0,
        base_sha: shaA,
        repository_head_sha: shaA,
        manager_message_id: 'msg-amb',
        manager_payload_hash: 'hash-amb',
        routing_decision_id: 'route-amb',
        selected_provider_id: 'provider-omniroute',
        selected_resource_id: 'coder-omniroute',
        instruction_payload_hash: 'hash-amb-2',
        context_manifest_hash: 'hash-amb-3',
        canonical_instructions_json: '[]',
        context_files_json: '[]',
        canonical_payload_json: null,
        status: 'AUTHORIZED',
        created_at: now,
      });

      let agyCalls = 0;
      let omniCalls = 0;
      const fakeAgy = {
        execute: async () => { agyCalls++; return { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: 'a', stdout: '', stderr: '', durationMs: 1 }; },
      } as unknown as AntigravityAdapter;

      const fakeOmni = {
        executeWorkOrder: async () => { omniCalls++; return { run: { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: 'o', stdout: '', stderr: '', durationMs: 1 } }; },
      } as unknown as ResponsesCoderEndpointTransport;

      const supervisor = new AutonomySupervisor({
        store,
        controlRepo: controlDir,
        worktreeRoot: tempDir,
        agy: fakeAgy,
        agyProviderId: 'provider-omniroute',
        agyResourceId: 'coder-omniroute',
        coderEndpoint: coderEndpointConfig(),
        coderTransport: fakeOmni,
        evidence: {
          collect: async () => ({
            headSha: shaA,
            status: '',
            changedFiles: [],
            diff: '',
            tests: [{ command: 'npm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
          }),
        },
      });

      const order = createWorkOrder({
        taskId: 'TSK-AMB-AUTH',
        workerId: 'agy-01',
        objective: 'ambiguous auth',
        baseSha: shaA,
        branch: 'test',
        worktree: worktreeDir,
        allowedPaths: ['src'],
        acceptanceCriteria: ['pass'],
        requiredTests: ['npm test'],
      });

      const result = await supervisor.run({
        taskId: order.task_id,
        objective: order.objective,
        baseSha: order.base_sha,
        branch: order.branch,
        worktree: order.worktree,
        allowedPaths: order.allowed_paths,
        forbiddenPaths: ['.git'],
        acceptanceCriteria: order.acceptance_criteria,
        requiredTests: order.required_tests,
        workerId: order.worker_id,
      });

      expect(result.state).toBe('BLOCKED');
      expect(result.error).toContain('AUTHORIZATION_AMBIGUOUS');
      expect(agyCalls).toBe(0);
      expect(omniCalls).toBe(0);
      db.close();
    });
  });

  describe('6. Fresh-authority AGY selection', () => {
    it('invokes AGY when a fresh authorization explicitly selects AGY provider', async () => {
      const selection = resolveCoderProvider({
        selected_provider_id: 'antigravity-cli',
        selected_resource_id: 'agy-01',
      } as ExecutionAuthorization, coderBinding('antigravity-cli', 'agy-01', 'LOCAL_CLI'), coderEndpointConfig(), {
        providerId: 'antigravity-cli',
        resourceId: 'agy-01',
      });
      expect(selection.provider).toBe('AGY');

      const db = new Database(':memory:');
      MigrationRunner.run(db);
      const store = new AutonomyStore(db);
      const repo: any = new Repository(db);

      const now = new Date().toISOString();
      repo.createProject({
        id: 'PROJ-AGY',
        name: 'Project AGY',
        repository_path: worktreeDir,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
      });

      repo.createTask({
        id: 'TSK-AGY-SELECT',
        project_id: 'PROJ-AGY',
        title: 'Task with AGY Coder',
        description: 'agy fresh selection',
        state: 'APPROVED',
        priority: 'HIGH',
        risk: 'LOW',
        revision_count: 0,
        max_revisions: 3,
        base_sha: shaA,
        current_sha: shaA,
        progress_cache_percent: 0,
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      });

      repo.createProvider({ id: 'provider-agy', name: 'Antigravity', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
      repo.createProviderAccount({
        id: 'account-agy',
        provider_id: 'provider-agy',
        label: 'Authorized Antigravity account',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://antigravity/default',
        enabled: true,
        priority: 100,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 2,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: now,
        updated_at: now,
      });
      repo.createProviderResource({
        id: 'resource-agy',
        provider_id: 'provider-agy',
        provider_account_id: 'account-agy',
        model_name: 'antigravity',
        health_status: 'AVAILABLE',
        capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: now,
      });
      repo.createRoleProfile({
        id: 'role-coder',
        role: 'CODER',
        display_name: 'Coder',
        required_capabilities: ['CODING'],
        preferred_capabilities: [],
        authority_scope: null,
        permissions: ['FILESYSTEM_EDIT'],
        output_protocol: 'coder.v1',
        enabled: true,
        created_at: now,
        updated_at: now,
      });
      repo.createWorkerSlot({
        id: 'slot-agy',
        provider_account_id: 'account-agy',
        provider_resource_id: 'resource-agy',
        slot_index: 1,
        status: 'IDLE',
        current_assignment_id: null,
        current_execution_id: null,
        heartbeat_at: null,
        created_at: now,
        updated_at: now,
      });
      repo.createAgentAssignment({
        id: 'assignment-agy',
        project_id: 'PROJ-AGY',
        task_id: 'TSK-AGY-SELECT',
        attempt_id: null,
        role_profile_id: 'role-coder',
        agent_profile_id: null,
        selected_provider_id: 'provider-agy',
        selected_account_id: 'account-agy',
        selected_resource_id: 'resource-agy',
        selected_worker_slot_id: 'slot-agy',
        routing_decision_id: 'route-agy',
        preferred_metadata: null,
        status: 'ASSIGNED',
        created_at: now,
        ended_at: null,
      });

      const context = new ContextBuilderService(repo).buildContextSnapshot({
        projectId: 'PROJ-AGY',
        taskId: 'TSK-AGY-SELECT',
        assignmentId: 'assignment-agy',
        purpose: 'EXECUTION',
        includeProjectMemory: false,
        includeTaskMemory: false,
        includeLatestCheckpoint: false,
        includeLatestHandoff: false,
      });

      const canonicalPayload: CanonicalExecutionPayload = {
        projectId: 'PROJ-AGY',
        taskId: 'TSK-AGY-SELECT',
        attemptId: null,
        taskTitle: 'Task with AGY Coder',
        taskDescription: 'agy fresh selection',
        acceptanceCriteria: ['pass'],
        constraints: ['MAX_AGY_WORKERS=1'],
        instructions: ['Implement'],
        contextFiles: [],
        verificationCommands: {
          TEST: { executable: 'npm', args: ['test'] },
          LINT: null,
          BUILD: null,
        },
        managerMessageId: 'msg-agy',
        managerPayloadHash: 'hash-agy',
        executionScope: {
          branch: 'agent/agy',
          worktree: worktreeDir,
          allowedPaths: ['src/app.ts'],
          forbiddenPaths: ['.git'],
        },
      };

      repo.recordProtocolMessage(
        'msg-agy',
        'ext-msg-agy',
        'manager.v1',
        'PROJ-AGY',
        'TSK-AGY-SELECT',
        'APPROVED',
        0,
        'hash-agy',
        JSON.stringify({ decision: 'EXECUTE', taskId: 'TSK-AGY-SELECT' }),
        'APPLIED',
      );

      const payloadHash = computePayloadHash(canonicalPayload);

      // Authorization explicitly selecting AGY
      repo.createExecutionAuthorization({
        id: 'AUTH-AGY-FRESH',
        project_id: 'PROJ-AGY',
        task_id: 'TSK-AGY-SELECT',
        attempt_id: null,
        task_revision: 0,
        base_sha: shaA,
        repository_head_sha: shaA,
        manager_message_id: 'msg-agy',
        manager_payload_hash: 'hash-agy',
        routing_decision_id: 'route-agy',
        selected_account_id: 'account-agy',
        selected_provider_id: 'provider-agy',
        selected_resource_id: 'resource-agy',
        instruction_payload_hash: payloadHash,
        context_manifest_hash: context.manifest.manifest_hash,
        canonical_instructions_json: JSON.stringify(canonicalPayload.instructions),
        context_files_json: '[]',
        canonical_payload_json: JSON.stringify(canonicalPayload),
        expected_task_revision: 0,
        status: 'AUTHORIZED',
        created_at: now,
        assignment_id: 'assignment-agy',
        task_ownership_epoch: 1,
        lifecycle_version: 1,
      });

      let agyExecuteCalls = 0;
      const fakeAgy = {
        execute: async () => {
          agyExecuteCalls++;
          return {
            status: 'SUCCESSFUL_PROCESS_EXIT' as const,
            exitCode: 0,
            executionId: 'agy-run-success',
            stdout: 'AGY OK',
            stderr: '',
            durationMs: 15,
          };
        },
      } as unknown as AntigravityAdapter;

      const supervisor = new AutonomySupervisor({
        store,
        controlRepo: controlDir,
        worktreeRoot: tempDir,
        agy: fakeAgy,
        agyProviderId: 'provider-agy',
        agyResourceId: 'resource-agy',
        coderEndpoint: coderEndpointConfig(),
        evidence: {
          collect: async () => ({
            headSha: shaA,
            status: '',
            changedFiles: ['src/app.ts'],
            diff: 'diff --git a/src/app.ts b/src/app.ts',
            tests: [{ command: 'npm test', exitCode: 0, stdout: '', stderr: '', durationMs: 5 }],
          }),
        },
      });

      const order = createWorkOrder({
        taskId: 'TSK-AGY-SELECT',
        workerId: 'agy-01',
        objective: 'agy fresh selection',
        baseSha: shaA,
        branch: 'agent/agy',
        worktree: worktreeDir,
        allowedPaths: ['src/app.ts'],
        acceptanceCriteria: ['pass'],
        requiredTests: ['npm test'],
      });

      // Supervisor executes with mock manager review passing
      vi.spyOn(supervisor.managerPool, 'review').mockResolvedValueOnce({
        run: { status: 'SUCCESSFUL_PROCESS_EXIT', exitCode: 0, executionId: 'rev', stdout: '', stderr: '', durationMs: 1 },
        review: {
          protocol_version: 'managerreview.v1',
          verdict: 'PASS',
          reviewed_head_sha: shaA,
          findings: [],
          required_actions: [],
          risk: 'LOW',
          notes: 'accepted',
        },
        attempts: ['codex-chatgpt-primary'],
        resource_id: 'codex-chatgpt-primary',
        context_sha: 'test-context-sha',
      });

      const execution = await supervisor.run({
        taskId: order.task_id,
        objective: order.objective,
        baseSha: order.base_sha,
        branch: order.branch,
        worktree: order.worktree,
        allowedPaths: order.allowed_paths,
        forbiddenPaths: ['.git'],
        acceptanceCriteria: order.acceptance_criteria,
        requiredTests: order.required_tests,
        workerId: order.worker_id,
      });

      // AGY was correctly invoked under fresh AGY authorization
      expect(agyExecuteCalls, JSON.stringify(execution)).toBe(1);
      db.close();
    });

    it('invokes AGY through product-task execution path when durable ExecutionAuthorization explicitly selects AGY', async () => {
      const db = new Database(':memory:');
      MigrationRunner.run(db);
      const store = new AutonomyStore(db);
      const repo: any = new Repository(db);

      const now = new Date().toISOString();
      repo.createProject({
        id: 'PROJ-PROD-AGY',
        name: 'Product Project AGY',
        repository_path: worktreeDir,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
      });

      repo.createTask({
        id: 'TSK-PROD-AGY-1',
        project_id: 'PROJ-PROD-AGY',
        title: 'Product Task with Explicit AGY Selection',
        description: 'Exercise AGY execution path',
        state: 'APPROVED',
        priority: 'HIGH',
        risk: 'LOW',
        revision_count: 0,
        max_revisions: 3,
        base_sha: shaA,
        current_sha: shaA,
        progress_cache_percent: 0,
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      });

      repo.createProvider({ id: 'provider-agy', name: 'Antigravity', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
      repo.createProviderAccount({
        id: 'account-agy',
        provider_id: 'provider-agy',
        label: 'Authorized Antigravity account',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://antigravity/default',
        enabled: true,
        priority: 100,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 2,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: now,
        updated_at: now,
      });
      repo.createProviderResource({
        id: 'resource-agy',
        provider_id: 'provider-agy',
        provider_account_id: 'account-agy',
        model_name: 'antigravity',
        health_status: 'AVAILABLE',
        capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: now,
      });
      repo.createRoleProfile({
        id: 'role-coder',
        role: 'CODER',
        display_name: 'Coder',
        required_capabilities: ['CODING'],
        preferred_capabilities: [],
        authority_scope: null,
        permissions: ['FILESYSTEM_EDIT'],
        output_protocol: 'coder.v1',
        enabled: true,
        created_at: now,
        updated_at: now,
      });
      repo.createWorkerSlot({
        id: 'slot-prod-agy',
        provider_account_id: 'account-agy',
        provider_resource_id: 'resource-agy',
        slot_index: 1,
        status: 'IDLE',
        current_assignment_id: null,
        current_execution_id: null,
        heartbeat_at: null,
        created_at: now,
        updated_at: now,
      });
      repo.createAgentAssignment({
        id: 'assignment-prod-agy',
        project_id: 'PROJ-PROD-AGY',
        task_id: 'TSK-PROD-AGY-1',
        attempt_id: null,
        role_profile_id: 'role-coder',
        agent_profile_id: null,
        selected_provider_id: 'provider-agy',
        selected_account_id: 'account-agy',
        selected_resource_id: 'resource-agy',
        selected_worker_slot_id: 'slot-prod-agy',
        routing_decision_id: 'route-prod-agy',
        preferred_metadata: null,
        status: 'ASSIGNED',
        created_at: now,
        ended_at: null,
      });

      const context = new ContextBuilderService(repo).buildContextSnapshot({
        projectId: 'PROJ-PROD-AGY',
        taskId: 'TSK-PROD-AGY-1',
        assignmentId: 'assignment-prod-agy',
        purpose: 'EXECUTION',
        includeProjectMemory: false,
        includeTaskMemory: false,
        includeLatestCheckpoint: false,
        includeLatestHandoff: false,
      });

      const testCommand = renderCommand({ executable: process.execPath, args: ['--version'] });
      const canonicalPayload: CanonicalExecutionPayload = {
        projectId: 'PROJ-PROD-AGY',
        taskId: 'TSK-PROD-AGY-1',
        attemptId: null,
        taskTitle: 'Product Task with Explicit AGY Selection',
        taskDescription: 'Exercise AGY execution path',
        acceptanceCriteria: ['Pass'],
        constraints: [],
        instructions: ['Implement'],
        contextFiles: [],
        verificationCommands: {
          TEST: { executable: process.execPath, args: ['--version'] },
          LINT: null,
          BUILD: null,
        },
        managerMessageId: 'mgr-prod-agy',
        managerPayloadHash: 'hash-mgr',
        executionScope: {
          branch: 'agent/agy/prod',
          worktree: worktreeDir,
          allowedPaths: ['src/app.ts'],
          forbiddenPaths: ['.git'],
        },
      };

      repo.recordProtocolMessage(
        'mgr-prod-agy',
        'ext-mgr-prod-agy',
        'manager.v1',
        'PROJ-PROD-AGY',
        'TSK-PROD-AGY-1',
        'APPROVED',
        0,
        'hash-mgr',
        JSON.stringify({ decision: 'EXECUTE', taskId: 'TSK-PROD-AGY-1' }),
        'APPLIED',
      );

      const payloadHash = computePayloadHash(canonicalPayload);

      repo.createExecutionAuthorization({
        id: 'AUTH-PROD-AGY-1',
        project_id: 'PROJ-PROD-AGY',
        task_id: 'TSK-PROD-AGY-1',
        attempt_id: null,
        task_revision: 0,
        base_sha: shaA,
        repository_head_sha: shaA,
        manager_message_id: 'mgr-prod-agy',
        manager_payload_hash: 'hash-mgr',
        routing_decision_id: 'route-prod-agy',
        selected_account_id: 'account-agy',
        selected_provider_id: 'provider-agy',
        selected_resource_id: 'resource-agy',
        instruction_payload_hash: payloadHash,
        context_manifest_hash: context.manifest.manifest_hash,
        canonical_instructions_json: JSON.stringify(canonicalPayload.instructions),
        context_files_json: '[]',
        canonical_payload_json: JSON.stringify(canonicalPayload),
        expected_task_revision: 0,
        status: 'AUTHORIZED',
        created_at: now,
        assignment_id: 'assignment-prod-agy',
        task_ownership_epoch: 1,
        lifecycle_version: 1,
      });

      let agyCalls = 0;
      const fakeAgy = {
        execute: async () => {
          agyCalls++;
          return {
            status: 'SUCCESSFUL_PROCESS_EXIT' as const,
            exitCode: 0,
            executionId: 'agy-prod-exec',
            stdout: 'AGY WORKER OK',
            stderr: '',
            durationMs: 10,
          };
        },
      } as unknown as AntigravityAdapter;

      const supervisor = new AutonomySupervisor({
        store,
        controlRepo: controlDir,
        worktreeRoot: tempDir,
        agy: fakeAgy,
        agyProviderId: 'provider-agy',
        agyResourceId: 'resource-agy',
        coderEndpoint: coderEndpointConfig(),
        evidence: {
          collect: async () => ({
            headSha: shaA,
            snapshotSha: 'snap-1',
            status: '',
            changedFiles: ['src/app.ts'],
            diff: 'diff',
            tests: [{ command: testCommand, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
          }),
        },
      });

      vi.spyOn(supervisor.managerPool, 'review').mockResolvedValueOnce({
        run: { status: 'SUCCESSFUL_PROCESS_EXIT', exitCode: 0, executionId: 'rev', stdout: '', stderr: '', durationMs: 1 },
        review: {
          protocol_version: 'managerreview.v1',
          verdict: 'PASS',
          reviewed_head_sha: shaA,
          findings: [],
          required_actions: [],
          risk: 'LOW',
          notes: 'pass',
        },
        attempts: ['codex-chatgpt-primary'],
        resource_id: 'codex-chatgpt-primary',
        context_sha: 'test-context-sha',
      });

      const result = await supervisor.runProductTask({
        taskId: 'TSK-PROD-AGY-1',
        workerId: 'agy-01',
        objective: 'Exercise AGY execution path',
        baseSha: shaA,
        branch: 'agent/agy/prod',
        worktree: worktreeDir,
        allowedPaths: ['src/app.ts'],
        forbiddenPaths: ['.git'],
        acceptanceCriteria: ['Pass'],
        requiredTests: [testCommand],
      });

      expect(agyCalls).toBe(1);
      expect(result.accepted).toBe(true);
      db.close();
    });
  });

  describe('7. Secret redaction', () => {
    it('disables generic adapter execution before any raw routed output can be returned', async () => {
      let fetchCalls = 0;
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => {
          fetchCalls++;
          return new Response(responsePayload(`${secretToken} https://router.example.test/v1`), { status: 200 });
        },
      });
      const result = await transport.execute(coderEndpointConfig(), {
        taskId: 'TSK-GENERIC-DISABLED',
        projectId: 'PROJ-GENERIC-DISABLED',
        instructions: ['return raw output'],
        contextFiles: [],
      });
      expect(fetchCalls).toBe(0);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('PROTOCOL_INVALID');
      expect(result.rawResponse).toBeUndefined();
      expect(result.error).not.toContain(secretToken);
      expect(result.error).not.toContain('router.example.test');
    });

    it('redacts credentials and endpoint values from post-response contract diagnostics', async () => {
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => new Response(responsePayload(JSON.stringify({
          protocol_version: 'coderbundle.v1',
          task_id: `wrong-${secretToken}-router.example.test`,
          authorization_id: 'auth-699',
          source_head: shaA,
          allowed_paths: ['src/app.ts'],
          proposed_edits: [{ path: 'src/app.ts', content: 'safe' }],
        })), { status: 200 }),
      });
      const order = createWorkOrder({
        taskId: 'TSK-699',
        workerId: 'coder-omniroute',
        objective: 'redact contract diagnostics',
        baseSha: shaA,
        branch: 'test',
        worktree: worktreeDir,
        allowedPaths: ['src/app.ts'],
        acceptanceCriteria: ['pass'],
        requiredTests: ['test'],
      });
      const result = await transport.executeWorkOrder(coderEndpointConfig(), order, 'auth-699');
      expect(result.run.status).toBe('CONTRACT_INVALID');
      expect(result.run.error).not.toContain(secretToken);
      expect(result.run.error).not.toContain('router.example.test');
      expect(result.run.error).toContain('[REDACTED_SECRET]');
      expect(result.run.error).toContain('[REDACTED_URL]');
    });

    it('redacts router credentials from 401 error responses', async () => {
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => new Response(`Unauthorized: bearer token ${secretToken} was rejected`, { status: 401 }),
      });

      const order = createWorkOrder({
        taskId: 'TSK-700',
        workerId: 'coder-omniroute',
        objective: 'secret redaction test',
        baseSha: shaA,
        branch: 'test',
        worktree: worktreeDir,
        allowedPaths: ['src'],
        acceptanceCriteria: ['pass'],
        requiredTests: ['npm test'],
      });

      const result = await transport.executeWorkOrder(coderEndpointConfig(), order, 'auth-700');
      expect(result.run.status).toBe('AUTH_ERROR');
      expect(result.run.stderr).not.toContain(secretToken);
      expect(result.run.stderr).toContain('[REDACTED_SECRET]');
    });

    it('redacts router credentials from 429 quota exhaustion errors', async () => {
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => new Response(JSON.stringify({
          error: {
            message: `Account with key ${secretToken} has exceeded spend limit: capacity exhausted`,
          },
        }), { status: 429 }),
      });

      const result = await transport.contract(coderEndpointConfig());
      expect(result.healthState).toBe('CAPACITY_EXHAUSTED');
      expect(result.run.stderr).not.toContain(secretToken);
      expect(result.run.stderr).toContain('[REDACTED_SECRET]');
      expect(result.run.stderr).toContain('ROUTE_CAPACITY_EXHAUSTED');
    });

    it('redacts router credentials from offline/network fetch exception messages', async () => {
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => {
          throw new Error(`fetch failed: connect ECONNREFUSED https://${secretToken}@router.example.test`);
        },
      });

      const result = await transport.contract(coderEndpointConfig());
      expect(result.healthState).toBe('OFFLINE');
      expect(result.run.stderr).not.toContain(secretToken);
      expect(result.run.stderr).toContain('[REDACTED_SECRET]');
      expect(result.run.stderr).toContain('ROUTE_OFFLINE');
    });

    it('redacts configured endpoint URL and host from fetch and error diagnostics', async () => {
      const config = coderEndpointConfig();
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => {
          throw new Error('fetch failed: connect ECONNREFUSED https://router.example.test/v1/responses');
        },
      });

      const result = await transport.contract(config);
      expect(result.healthState).toBe('OFFLINE');
      expect(result.run.stderr).not.toContain('router.example.test');
      expect(result.run.stderr).toContain('[REDACTED_URL]');
      expect(result.run.stderr).toContain('ROUTE_OFFLINE');
    });
  });

  describe('8. Live Coder Doctor Command', () => {
    it('verifies structured coder contract without touching repository or creating files', async () => {
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => new Response(responsePayload(JSON.stringify({
          protocol_version: 'coderbundle.v1',
          task_id: 'doctor-probe',
          authorization_id: 'auth-doctor-probe',
          source_head: '0'.repeat(40),
          allowed_paths: ['doctor-probe.txt'],
          proposed_edits: [{ path: 'doctor-probe.txt', content: 'CODER_OK' }],
        })), { status: 200 }),
      });

      const result = await transport.contract(coderEndpointConfig());
      expect(result.compatible).toBe(true);
      expect(result.healthState).toBe('AVAILABLE');
      expect(result.run.status).toBe('SUCCESSFUL_PROCESS_EXIT');

      // Verify no probe file was created on filesystem
      expect(fs.existsSync(path.join(worktreeDir, 'doctor-probe.txt'))).toBe(false);
    });

    it.each([
      {
        name: 'mismatched allowed_paths',
        allowed_paths: ['other.txt'],
        proposed_edits: [{ path: 'other.txt', content: 'CODER_OK' }],
      },
      {
        name: 'unauthorized edit path',
        allowed_paths: ['doctor-probe.txt'],
        proposed_edits: [{ path: 'other.txt', content: 'CODER_OK' }],
      },
      {
        name: 'traversal edit path',
        allowed_paths: ['doctor-probe.txt'],
        proposed_edits: [{ path: '../outside.txt', content: 'CODER_OK' }],
      },
    ])('rejects a path-unbound doctor response: $name', async ({ allowed_paths, proposed_edits }) => {
      const transport = new ResponsesCoderEndpointTransport({
        environment: { TEST_CODER_AUTH: secretToken },
        fetch: async () => new Response(responsePayload(JSON.stringify({
          protocol_version: 'coderbundle.v1',
          task_id: 'doctor-probe',
          authorization_id: 'auth-doctor-probe',
          source_head: '0'.repeat(40),
          allowed_paths,
          proposed_edits,
        })), { status: 200 }),
      });
      const result = await transport.contract(coderEndpointConfig());
      expect(result.compatible).toBe(false);
      expect(result.healthState).toBe('CONTRACT_INVALID');
      expect(result.run.status).toBe('CONTRACT_INVALID');
    });

    it('CLI doctorOmniRouteCoder passes when endpoint is configured and compatible', async () => {
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_ENABLED', '1');
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_BASE_URL', 'https://router.example.test/v1');
      vi.stubEnv('AGENT_FORGE_CODER_MODEL', 'coder-production-model');
      vi.stubEnv('TEST_CODER_AUTH', secretToken);
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_AUTH_ENV', 'TEST_CODER_AUTH');

      // Spy on global fetch for the doctor call
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(responsePayload(JSON.stringify({
          protocol_version: 'coderbundle.v1',
          task_id: 'doctor-probe',
          authorization_id: 'auth-doctor-probe',
          source_head: '0'.repeat(40),
          allowed_paths: ['doctor-probe.txt'],
          proposed_edits: [{ path: 'doctor-probe.txt', content: 'CODER_OK' }],
        })), { status: 200 })
      );

      const code = await doctorOmniRouteCoder();
      expect(code).toBe(0);
      fetchSpy.mockRestore();
    });

    it('CLI doctorOmniRouteCoder fails when endpoint returns contract invalid', async () => {
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_ENABLED', '1');
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_BASE_URL', 'https://router.example.test/v1');
      vi.stubEnv('AGENT_FORGE_CODER_MODEL', 'coder-production-model');
      vi.stubEnv('TEST_CODER_AUTH', secretToken);
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_AUTH_ENV', 'TEST_CODER_AUTH');

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response('not-valid-json', { status: 200 })
      );

      const code = await doctorOmniRouteCoder();
      expect(code).toBe(1);
      fetchSpy.mockRestore();
    });
  });

  describe('9. Role capabilities & Lease/Git/Test authority', () => {
    it('loadOmniRouteEndpointFromEnvironment does not grant TEST_EXECUTION to CODER role', () => {
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_ENABLED', '1');
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_BASE_URL', 'https://router.example.test/v1');
      vi.stubEnv('AGENT_FORGE_CODER_MODEL', 'coder-production-model');
      vi.stubEnv('TEST_CODER_AUTH', secretToken);

      const endpoint = loadOmniRouteEndpointFromEnvironment('CODER');
      expect(endpoint).not.toBeNull();
      expect(endpoint?.capabilities).toContain('CODING');
      expect(endpoint?.capabilities).not.toContain('TEST_EXECUTION');
      expect(endpoint?.capabilities).not.toContain('REVIEW');
    });
  });
});
