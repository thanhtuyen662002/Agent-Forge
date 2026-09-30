import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import {
  LocalCliAdapterBase,
  LocalCliAdapterOptions,
  recoverOrphanedLocalCliWorkspaces,
} from '../src/core/adapters/LocalCliAdapterBase';
import { AgentExecutionRequest } from '../src/core/adapters/ProviderAdapter';

const CODER_PAYLOAD = {
  protocol: 'coder.v1',
  message_id: 'workspace-isolation-test',
  project_id: 'PROJ-WORKSPACE-TEST',
  task_id: 'TSK-WORKSPACE-TEST',
  attempt: 1,
  status: 'COMPLETED',
  completed: ['Provider completed in the isolated workspace'],
  remaining: [],
  files_claimed_changed: ['src/allowed.ts'],
  tests_claimed: ['workspace isolation test'],
  blockers: [],
  review_requested: false,
  expected_task_state: 'CODING',
  expected_revision: 0,
};

class FixtureLocalCliAdapter extends LocalCliAdapterBase {
  public readonly id = 'fixture-local-cli';
  public readonly name = 'Fixture local CLI';

  public constructor(
    private readonly runnerPath: string,
    private readonly probeDirectory: string,
    options: LocalCliAdapterOptions,
  ) {
    super({ ...options, executable: process.execPath });
  }

  protected getDefaultExecutable(): string {
    return process.execPath;
  }

  public async getCapabilities() {
    return ['CODING' as const];
  }

  protected buildExecutionArgs(): string[] {
    return [this.runnerPath, this.probeDirectory];
  }
}

describe('Local CLI provider workspace isolation', () => {
  let tmpDir: string;
  let projectRoot: string;
  let probeDirectory: string;
  let runnerPath: string;
  let db: Database.Database;
  let repo: Repository;
  let artifactStore: ArtifactStore;
  let adapter: FixtureLocalCliAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-cli-workspace-test-'));
    projectRoot = path.join(tmpDir, 'project');
    probeDirectory = path.join(tmpDir, 'probes');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(probeDirectory, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'allowed.ts'), 'export const value = 1;\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'unlisted.txt'), 'must stay outside the provider workspace\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, '.env.local'), 'TOP_SECRET=do-not-copy\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, '.git', 'config'), '[remote "origin"]\nurl=secret\n', 'utf8');

    runnerPath = path.join(tmpDir, 'fixture-provider.js');
    fs.writeFileSync(runnerPath, `
      const fs = require('fs');
      const path = require('path');
      const probeDirectory = process.argv[2];
      let prompt = '';
      try { prompt = fs.readFileSync(0, 'utf8'); } catch {}
      const cwd = process.cwd();
      const result = {
        cwd,
        envPresent: fs.existsSync(path.join(cwd, '.env.local')),
        gitConfigPresent: fs.existsSync(path.join(cwd, '.git', 'config')),
        unlistedPresent: fs.existsSync(path.join(cwd, 'unlisted.txt')),
        parentUnlistedPresent: fs.existsSync(path.join(cwd, '..', 'unlisted.txt')),
      };
      if (prompt.includes('MODIFY_ALLOWED')) {
        fs.appendFileSync(path.join(cwd, 'src', 'allowed.ts'), '\\nexport const providerChange = true;\\n');
      }
      if (prompt.includes('MODIFY_SECOND')) {
        fs.appendFileSync(path.join(cwd, 'src', 'second.ts'), '\\nexport const secondProviderChange = true;\\n');
      }
      const probe = path.join(probeDirectory, 'probe-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
      fs.writeFileSync(probe, JSON.stringify(result), 'utf8');
      const finish = () => {
        process.stdout.write(JSON.stringify(${JSON.stringify(CODER_PAYLOAD)}) + '\\n');
      };
      if (prompt.includes('SLEEP')) setTimeout(finish, 250); else finish();
    `, 'utf8');

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifactStore = new ArtifactStore(path.join(tmpDir, 'artifacts'));
    const now = new Date().toISOString();
    repo.createProject({
      id: 'PROJ-WORKSPACE-TEST',
      name: 'Workspace isolation test project',
      description: null,
      repository_path: projectRoot,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
    });
    repo.createTask({
      id: 'TSK-WORKSPACE-TEST',
      project_id: 'PROJ-WORKSPACE-TEST',
      milestone_id: null,
      title: 'Workspace isolation test task',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 5,
      base_sha: '0000000000000000000000000000000000000000',
      current_sha: '0000000000000000000000000000000000000000',
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['workspace is isolated'],
      constraints: [],
      created_at: now,
      updated_at: now,
    });
    adapter = new FixtureLocalCliAdapter(runnerPath, probeDirectory, {
      repo,
      artifactStore,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function request(instructions: string[] = ['MODIFY_ALLOWED'], contextFiles: string[] = ['src/allowed.ts']): AgentExecutionRequest {
    return {
      taskId: 'TSK-WORKSPACE-TEST',
      projectId: 'PROJ-WORKSPACE-TEST',
      instructions,
        contextFiles,
      runtimeBinding: {
        authorizationId: 'auth-workspace-test',
        routingDecisionId: 'decision-workspace-test',
        assignmentId: 'assignment-workspace-test',
        providerId: 'fixture-local-cli',
        accountId: 'account-workspace-test',
        resourceId: 'resource-workspace-test',
        adapterType: 'LOCAL_CLI',
        modelName: 'fixture',
        accountAuthMode: 'NATIVE_PROFILE',
        profileRef: null,
      },
    };
  }

  function probes(): Array<{ cwd: string; envPresent: boolean; gitConfigPresent: boolean; unlistedPresent: boolean; parentUnlistedPresent: boolean }> {
    return fs.readdirSync(probeDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(probeDirectory, name), 'utf8')));
  }

  it('runs in a secret-free workspace and synchronizes only authorized files', async () => {
    const result = await adapter.execute(request());

    expect(result.status).toBe('COMPLETED');
    expect(fs.readFileSync(path.join(projectRoot, 'src', 'allowed.ts'), 'utf8')).toContain('providerChange');
    expect(fs.readFileSync(path.join(projectRoot, '.env.local'), 'utf8')).toBe('TOP_SECRET=do-not-copy\n');
    expect(fs.readFileSync(path.join(projectRoot, '.git', 'config'), 'utf8')).toContain('secret');
    const [probe] = probes();
    expect(probe.cwd).not.toBe(projectRoot);
    expect(probe.cwd).toMatch(/agent-forge-local-cli-workspaces/i);
    expect(probe.envPresent).toBe(false);
    expect(probe.gitConfigPresent).toBe(false);
    expect(probe.unlistedPresent).toBe(false);
    expect(probe.parentUnlistedPresent).toBe(false);
    expect(fs.existsSync(probe.cwd)).toBe(false);
  });

  it('rejects a sensitive context target before spawning the provider', async () => {
    const result = await adapter.execute({ ...request([]), contextFiles: ['.env.local'] });

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('POLICY_DENIAL');
    expect(result.error).toContain('SECURITY_POLICY_VIOLATION');
    expect(probes()).toHaveLength(0);
  });

  it('rejects Windows alternate data stream context paths', async () => {
    if (process.platform !== 'win32') return;

    const result = await adapter.execute({ ...request([]), contextFiles: ['src/allowed.ts:secret'] });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('CONTEXT_PATH_INVALID');
    expect(probes()).toHaveLength(0);
  });

  it('bounds directory context traversal depth before spawning the provider', async () => {
    let deepDirectory = path.join(projectRoot, 'deep-context');
    fs.mkdirSync(deepDirectory);
    for (let index = 0; index < 129; index += 1) {
      deepDirectory = path.join(deepDirectory, `level-${index}`);
      fs.mkdirSync(deepDirectory);
    }

    const result = await adapter.execute({ ...request([]), contextFiles: ['deep-context'] });

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('POLICY_DENIAL');
    expect(result.error).toContain('CONTEXT_LIMIT_EXCEEDED');
    expect(probes()).toHaveLength(0);
  });

  it('bounds directory entry enumeration before materializing a large tree', async () => {
    const fanoutDirectory = path.join(projectRoot, 'fanout-context');
    fs.mkdirSync(fanoutDirectory);
    for (let index = 0; index < 513; index += 1) {
      fs.mkdirSync(path.join(fanoutDirectory, `entry-${index}`));
    }

    const result = await adapter.execute({ ...request([]), contextFiles: ['fanout-context'] });

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('POLICY_DENIAL');
    expect(result.error).toContain('CONTEXT_LIMIT_EXCEEDED');
    expect(probes()).toHaveLength(0);
  });

  it('does not synchronize provider edits when the protocol is invalid', async () => {
    const invalidRunnerPath = path.join(tmpDir, 'invalid-provider.js');
    fs.writeFileSync(invalidRunnerPath, `
      const fs = require('fs');
      const path = require('path');
      let prompt = ''; try { prompt = fs.readFileSync(0, 'utf8'); } catch {}
      if (prompt.includes('MODIFY_ALLOWED')) fs.appendFileSync(path.join(process.cwd(), 'src', 'allowed.ts'), '\\ninvalid provider change\\n');
      process.stdout.write('not a coder protocol\\n');
    `, 'utf8');
    const invalidAdapter = new FixtureLocalCliAdapter(invalidRunnerPath, probeDirectory, { repo, artifactStore, timeoutMs: 5000 });

    const result = await invalidAdapter.execute(request());

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('PROTOCOL_INVALID');
    expect(fs.readFileSync(path.join(projectRoot, 'src', 'allowed.ts'), 'utf8')).not.toContain('invalid provider change');
  });

  it('rolls back an earlier synchronized file when a later source conflicts', async () => {
    const secondPath = path.join(projectRoot, 'src', 'second.ts');
    fs.writeFileSync(secondPath, 'export const second = 1;\n', 'utf8');
    const allowedPath = path.join(projectRoot, 'src', 'allowed.ts');
    const originalAllowed = fs.readFileSync(allowedPath, 'utf8');
    const originalRename = fs.renameSync.bind(fs);
    let firstWriteObserved = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((source, target) => {
      const result = originalRename(source, target);
      if (target === allowedPath && !firstWriteObserved) {
        firstWriteObserved = true;
        fs.writeFileSync(secondPath, 'external concurrent update\n', 'utf8');
      }
      return result;
    }) as typeof fs.renameSync);

    try {
      const result = await adapter.execute(
        request(['MODIFY_ALLOWED', 'MODIFY_SECOND'], ['src/allowed.ts', 'src/second.ts']),
      );

      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('WORKSPACE_SYNC_CONFLICT');
      expect(fs.readFileSync(allowedPath, 'utf8')).toBe(originalAllowed);
      expect(fs.readFileSync(secondPath, 'utf8')).toBe('external concurrent update\n');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('gives concurrent executions distinct workspaces and cleans both leases', async () => {
    const [first, second] = await Promise.all([
      adapter.execute(request(['SLEEP'])),
      adapter.execute(request(['SLEEP'])),
    ]);

    expect(first.status).toBe('COMPLETED');
    expect(second.status).toBe('COMPLETED');
    const paths = probes().map((probe) => probe.cwd);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    for (const workspacePath of paths) expect(fs.existsSync(workspacePath)).toBe(false);
  });

  it('fails closed for a symlink context target when the platform permits creating one', async () => {
    const outsidePath = path.join(tmpDir, 'outside.ts');
    const linkPath = path.join(projectRoot, 'linked.ts');
    fs.writeFileSync(outsidePath, 'outside\n', 'utf8');
    let supported = true;
    try {
      fs.symlinkSync(outsidePath, linkPath, 'file');
    } catch {
      supported = false;
    }
    if (!supported) return;

    const result = await adapter.execute({ ...request([]), contextFiles: ['linked.ts'] });

    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/SECURITY_POLICY_VIOLATION|CONTEXT_REPARSE_POINT|CONTEXT_PATH_DENIED/);
    expect(probes()).toHaveLength(0);
  });

  it('recovers only stale, well-formed orphan markers', () => {
    const basePath = path.join(tmpDir, 'workspace-base');
    const workspaceName = 'orphan-execution-token';
    const workspacePath = path.join(basePath, workspaceName);
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'payload.txt'), 'orphan', 'utf8');
    const workspaceStat = fs.lstatSync(workspacePath);
    fs.writeFileSync(path.join(basePath, `${workspaceName}.workspace.json`), JSON.stringify({
      version: 1,
      executionId: 'orphan-execution',
      ownerToken: 'orphan-owner',
      workspaceName,
      workspaceIdentityKey: `${process.platform === 'win32' ? 'win32' : String(workspaceStat.dev)}:${String(workspaceStat.ino)}:${String(workspaceStat.mode & 0o170000)}`,
      workspaceIdentityRealPath: fs.realpathSync(workspacePath),
      ownershipDigest: 'epoch-1',
      createdAt: new Date(0).toISOString(),
      state: 'ACTIVE',
    }), 'utf8');
    fs.writeFileSync(path.join(basePath, 'malformed.workspace.json'), '{not-json', 'utf8');

    const result = recoverOrphanedLocalCliWorkspaces(basePath, Date.now(), 1000);

    expect(result.recovered).toEqual([workspaceName]);
    expect(result.skipped).toContain('malformed.workspace.json');
    expect(fs.existsSync(workspacePath)).toBe(false);
    expect(fs.existsSync(path.join(basePath, `${workspaceName}.workspace.json`))).toBe(false);
  });

  it('never lets a stale marker redirect recovery to another workspace', () => {
    const basePath = path.join(tmpDir, 'workspace-base-redirection');
    const victimName = 'live-victim';
    const victimPath = path.join(basePath, victimName);
    fs.mkdirSync(victimPath, { recursive: true });
    fs.writeFileSync(path.join(victimPath, 'payload.txt'), 'must survive', 'utf8');
    const victimStat = fs.lstatSync(victimPath);
    const victimIdentity = {
      key: `${process.platform === 'win32' ? 'win32' : String(victimStat.dev)}:${String(victimStat.ino)}:${String(victimStat.mode & 0o170000)}`,
      realPath: fs.realpathSync(victimPath),
    };

    // The filename says "unbound" while the payload tries to target victim.
    fs.writeFileSync(path.join(basePath, 'unbound.workspace.json'), JSON.stringify({
      version: 1,
      executionId: 'forged-execution',
      ownerToken: 'forged-owner',
      workspaceName: victimName,
      ...victimIdentity,
      ownershipDigest: 'forged-epoch',
      createdAt: new Date(0).toISOString(),
      state: 'ACTIVE',
    }), 'utf8');

    const result = recoverOrphanedLocalCliWorkspaces(basePath, Date.now(), 1000);

    expect(result.skipped).toContain('unbound.workspace.json');
    expect(fs.existsSync(victimPath)).toBe(true);
    expect(fs.readFileSync(path.join(victimPath, 'payload.txt'), 'utf8')).toBe('must survive');
    expect(fs.existsSync(path.join(basePath, 'unbound.workspace.json'))).toBe(true);
  });

  it('retains a correctly named marker when its workspace identity no longer matches', () => {
    const basePath = path.join(tmpDir, 'workspace-base-identity');
    const victimName = 'replaced-workspace';
    const victimPath = path.join(basePath, victimName);
    const otherPath = path.join(basePath, 'other-workspace');
    fs.mkdirSync(victimPath, { recursive: true });
    fs.mkdirSync(otherPath, { recursive: true });
    fs.writeFileSync(path.join(victimPath, 'payload.txt'), 'new workspace', 'utf8');
    const otherStat = fs.lstatSync(otherPath);
    fs.writeFileSync(path.join(basePath, `${victimName}.workspace.json`), JSON.stringify({
      version: 1,
      executionId: 'replaced-execution',
      ownerToken: 'replaced-owner',
      workspaceName: victimName,
      workspaceIdentityKey: `${process.platform === 'win32' ? 'win32' : String(otherStat.dev)}:${String(otherStat.ino)}:${String(otherStat.mode & 0o170000)}`,
      workspaceIdentityRealPath: fs.realpathSync(otherPath),
      ownershipDigest: 'old-epoch',
      createdAt: new Date(0).toISOString(),
      state: 'ACTIVE',
    }), 'utf8');

    const result = recoverOrphanedLocalCliWorkspaces(basePath, Date.now(), 1000);

    expect(result.skipped).toContain(`${victimName}.workspace.json`);
    expect(fs.existsSync(victimPath)).toBe(true);
    expect(fs.existsSync(path.join(basePath, `${victimName}.workspace.json`))).toBe(true);
  });
});
