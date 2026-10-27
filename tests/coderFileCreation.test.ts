import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { LocalCliAdapterBase, LocalCliAdapterOptions } from '../src/core/adapters/LocalCliAdapterBase';
import { AgentExecutionRequest } from '../src/core/adapters/ProviderAdapter';

const CODER_PAYLOAD = {
  protocol: 'coder.v1', message_id: 'file-creation-test', project_id: 'PROJ-FILES', task_id: 'TSK-FILES', attempt: 1,
  status: 'COMPLETED', completed: ['done'], remaining: [], files_claimed_changed: [], tests_claimed: [], blockers: [],
  review_requested: false, expected_task_state: 'CODING', expected_revision: 0,
};

/** A provider that performs the file operations named in its prompt, in its isolated cwd. */
class FileOpsAdapter extends LocalCliAdapterBase {
  public readonly id = 'fixture-file-ops';
  public readonly name = 'Fixture file operations';
  public constructor(private readonly runnerPath: string, options: LocalCliAdapterOptions) {
    super({ ...options, executable: process.execPath });
  }
  protected getDefaultExecutable(): string { return process.execPath; }
  public async getCapabilities() { return ['CODING' as const]; }
  protected buildExecutionArgs(): string[] { return [this.runnerPath]; }
}

/**
 * #240: a CLI coder may create and delete files inside the directories it was
 * authorized for. Everything else stays refused, and a failure rolls back
 * every write, creation and deletion.
 */
describe('CLI coder file creation and deletion within its authorized scope (#240)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let db: Database.Database;
  let repo: Repository;
  let adapter: FileOpsAdapter;
  const src = (...parts: string[]) => path.join(projectRoot, 'src', ...parts);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-file-creation-'));
    projectRoot = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(src('existing.ts'), 'export const existing = 1;\n', 'utf8');
    fs.writeFileSync(src('obsolete.ts'), 'export const obsolete = 1;\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Project\n', 'utf8');
    execFileSync('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: projectRoot, stdio: 'ignore', windowsHide: true });

    const runnerPath = path.join(tmpDir, 'file-ops-provider.js');
    fs.writeFileSync(runnerPath, `
      const fs = require('fs');
      const path = require('path');
      let prompt = '';
      try { prompt = fs.readFileSync(0, 'utf8'); } catch {}
      const cwd = process.cwd();
      const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
      if (prompt.includes('EDIT_EXISTING')) fs.appendFileSync(path.join(cwd, 'src', 'existing.ts'), 'export const edited = true;\\n');
      if (prompt.includes('CREATE_NEW')) write('src/new.ts', 'export const created = true;\\n');
      if (prompt.includes('CREATE_NESTED')) write('src/feature/deep/module.ts', 'export const nested = true;\\n');
      if (prompt.includes('CREATE_OUTSIDE')) write('outside.txt', 'not authorized\\n');
      if (prompt.includes('CREATE_BIN')) write('bin/stats.js', 'console.log(1);\\n');
      if (prompt.includes('CREATE_BIN_EXTRA')) write('bin/other.js', 'console.log(2);\\n');
      if (prompt.includes('RECREATE_README')) write('README.md', '# Rewritten\\n');
      if (prompt.includes('EDIT_README')) fs.appendFileSync(path.join(cwd, 'README.md'), 'More docs\\n');
      if (prompt.includes('CREATE_SENSITIVE')) write('src/.env.production', 'SECRET=1\\n');
      if (prompt.includes('DELETE_OBSOLETE')) fs.unlinkSync(path.join(cwd, 'src', 'obsolete.ts'));
      if (prompt.includes('CREATE_AGENT_CONFIG')) write('src/.claude/settings.json', '{"hooks":{}}');
      if (prompt.includes('CREATE_CONFLICT')) write('src/conflict.ts', 'from provider\\n');
      const link = /LINK_TO:(.+)/.exec(prompt);
      if (link) { try { fs.symlinkSync(link[1].trim(), path.join(cwd, 'src', 'link'), 'junction'); } catch {} }
      const plant = /PLANT:(.+)/.exec(prompt);
      if (plant) fs.writeFileSync(plant[1].trim(), 'from the owner\\n');
      if (prompt.includes('CREATE_MANY')) for (let i = 0; i < 130; i++) write('src/many/f' + i + '.ts', 'x');
      process.stdout.write(JSON.stringify(${JSON.stringify(CODER_PAYLOAD)}) + '\\n');
    `, 'utf8');

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    const now = new Date().toISOString();
    repo.createProject({
      id: 'PROJ-FILES', name: 'File creation project', description: null, repository_path: projectRoot, default_branch: 'main',
      status: 'READY', contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null,
    }, captureRepositoryRoot(projectRoot));
    repo.createTask({
      id: 'TSK-FILES', project_id: 'PROJ-FILES', milestone_id: null, title: 'File creation task', description: null, state: 'CODING',
      paused_from_state: null, priority: 'HIGH', risk: 'LOW', assigned_agent_id: null, revision_count: 0, max_revisions: 5,
      base_sha: '0'.repeat(40), current_sha: '0'.repeat(40), progress_cache_percent: 0, progress_computed_at: null,
      acceptance_criteria: ['files'], constraints: [], created_at: now, updated_at: now,
    });
    adapter = new FileOpsAdapter(runnerPath, { repo, artifactStore: new ArtifactStore(path.join(tmpDir, 'artifacts')), timeoutMs: 10_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const run = (ops: string[], contextFiles: string[] = ['src']) => adapter.execute({
    taskId: 'TSK-FILES', projectId: 'PROJ-FILES', instructions: ops, contextFiles,
    runtimeBinding: {
      authorizationId: 'auth-files', routingDecisionId: 'decision-files', assignmentId: 'assignment-files', providerId: 'fixture-file-ops',
      accountId: 'account-files', resourceId: 'resource-files', adapterType: 'LOCAL_CLI', modelName: 'fixture',
      accountAuthMode: 'NATIVE_PROFILE', profileRef: null,
    },
  } satisfies AgentExecutionRequest);

  it('synchronizes new and nested files created inside an authorized directory, with edits', async () => {
    const result = await run(['EDIT_EXISTING', 'CREATE_NEW', 'CREATE_NESTED']);

    expect(result.status).toBe('COMPLETED');
    expect(fs.readFileSync(src('existing.ts'), 'utf8')).toContain('edited');
    expect(fs.readFileSync(src('new.ts'), 'utf8')).toBe('export const created = true;\n');
    expect(fs.readFileSync(src('feature', 'deep', 'module.ts'), 'utf8')).toBe('export const nested = true;\n');
  });

  it('synchronizes the deletion of an authorized file', async () => {
    const result = await run(['DELETE_OBSOLETE']);

    expect(result.status).toBe('COMPLETED');
    expect(fs.existsSync(src('obsolete.ts'))).toBe(false);
    expect(fs.existsSync(src('existing.ts'))).toBe(true);
  });

  it('refuses a file created outside the authorized directories and writes nothing', async () => {
    const result = await run(['EDIT_EXISTING', 'CREATE_NEW', 'CREATE_OUTSIDE']);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('WORKSPACE_SYNC_OUT_OF_SCOPE');
    expect(fs.existsSync(path.join(projectRoot, 'outside.txt'))).toBe(false);
    expect(fs.existsSync(src('new.ts'))).toBe(false);
    expect(fs.readFileSync(src('existing.ts'), 'utf8')).toBe('export const existing = 1;\n');
  });

  it('refuses a sensitive file name even inside an authorized directory', async () => {
    const result = await run(['CREATE_NEW', 'CREATE_SENSITIVE']);

    expect(result.status).toBe('FAILED');
    expect(fs.existsSync(src('.env.production'))).toBe(false);
    expect(fs.existsSync(src('new.ts'))).toBe(false);
  });

  it('refuses agent CLI configuration (hooks, MCP servers) the provider tries to plant', async () => {
    const result = await run(['CREATE_NEW', 'CREATE_AGENT_CONFIG']);

    expect(result.status).toBe('FAILED');
    expect(fs.existsSync(src('.claude'))).toBe(false);
    expect(fs.existsSync(src('new.ts'))).toBe(false);
  });

  it('refuses to overwrite a file that appeared in the source during execution', async () => {
    // While the provider runs, the owner creates the same file in the source.
    const result = await run(['EDIT_EXISTING', 'CREATE_CONFLICT', `PLANT:${src('conflict.ts')}`]);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('WORKSPACE_SYNC_CONFLICT');
    expect(fs.readFileSync(src('conflict.ts'), 'utf8')).toBe('from the owner\n');
    expect(fs.readFileSync(src('existing.ts'), 'utf8')).toBe('export const existing = 1;\n');
  });

  it('refuses a link the provider created, and never follows it into the source', async () => {
    const outside = path.join(tmpDir, 'outside-dir');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
    const result = await run(['CREATE_NEW', `LINK_TO:${outside}`]);

    expect(fs.existsSync(src('link'))).toBe(false);
    expect(fs.existsSync(src('new.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n');
    if (result.status === 'FAILED') expect(result.error).toContain('WORKSPACE_REPARSE_POINT');
    else expect(result.status).toBe('COMPLETED'); // the platform refused to create the link at all
  });

  it('bounds the number of created files', async () => {
    const result = await run(['CREATE_MANY']);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('WORKSPACE_SYNC_LIMIT_EXCEEDED');
    expect(fs.existsSync(src('many'))).toBe(false);
  });

  it('rolls back creations, deletions and edits when a later write fails', async () => {
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith(path.join('deep', 'module.ts'))) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return originalRename(from, to);
    }) as typeof fs.renameSync);

    const result = await run(['EDIT_EXISTING', 'DELETE_OBSOLETE', 'CREATE_NEW', 'CREATE_NESTED']);

    expect(result.status).toBe('FAILED');
    expect(fs.readFileSync(src('existing.ts'), 'utf8')).toBe('export const existing = 1;\n');
    expect(fs.readFileSync(src('obsolete.ts'), 'utf8')).toBe('export const obsolete = 1;\n');
    expect(fs.existsSync(src('new.ts'))).toBe(false);
    expect(fs.existsSync(src('feature'))).toBe(false);
  });

  it('creates files inside an authorized directory that does not exist yet (#287)', async () => {
    const result = await run(['CREATE_BIN', 'CREATE_NEW'], ['src', 'bin']);

    expect(result.status).toBe('COMPLETED');
    expect(fs.readFileSync(path.join(projectRoot, 'bin', 'stats.js'), 'utf8')).toBe('console.log(1);\n');
    expect(fs.existsSync(src('new.ts'))).toBe(true);
  });

  it('creates exactly an authorized new file path, and nothing beside it (#287)', async () => {
    expect((await run(['CREATE_BIN'], ['src', 'bin/stats.js'])).status).toBe('COMPLETED');
    expect(fs.existsSync(path.join(projectRoot, 'bin', 'stats.js'))).toBe(true);
    fs.rmSync(path.join(projectRoot, 'bin'), { recursive: true });

    const result = await run(['CREATE_BIN', 'CREATE_BIN_EXTRA'], ['src', 'bin/stats.js']);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('WORKSPACE_SYNC_OUT_OF_SCOPE');
    expect(fs.existsSync(path.join(projectRoot, 'bin'))).toBe(false);
  });

  it('refuses to recreate an existing repository file the provider was not given', async () => {
    const result = await run(['CREATE_NEW', 'RECREATE_README'], ['src']);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('WORKSPACE_SYNC_OUT_OF_SCOPE');
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('# Project\n');
    expect(fs.existsSync(src('new.ts'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('retries a replacement briefly held open by another process (#287)', async () => {
    const originalRename = fs.renameSync.bind(fs);
    let refusals = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith(path.join('src', 'existing.ts')) && refusals < 2) {
        refusals += 1;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);

    const result = await run(['EDIT_EXISTING']);

    expect(result.status).toBe('COMPLETED');
    expect(refusals).toBe(2);
    expect(fs.readFileSync(src('existing.ts'), 'utf8')).toContain('edited');
  });

  it('synchronizes an edit of a file at the repository root (#293)', async () => {
    const result = await run(['EDIT_README'], ['README.md', 'src']);

    expect(result.error ?? null).toBeNull();
    expect(result.status).toBe('COMPLETED');
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('# Project\nMore docs\n');
  });

  it('keeps refusing new files when only individual files were authorized', async () => {
    const result = await run(['EDIT_EXISTING', 'CREATE_NEW'], ['src/existing.ts']);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('WORKSPACE_SYNC_OUT_OF_SCOPE');
    expect(fs.readFileSync(src('existing.ts'), 'utf8')).toBe('export const existing = 1;\n');
  });
});
