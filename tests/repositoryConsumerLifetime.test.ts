import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { GitService } from '../src/core/services/GitService';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { ManagerProtocol } from '../src/core/types/protocols';

describe('selected repository consumer operation lifetime', () => {
  let root: string;
  let db: Database.Database;
  let repo: Repository;
  let tasks: TaskService;
  let head: string;
  let decision: ManagerProtocol;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-consumer-lifetime-')));
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q', '--template=', '--initial-branch=main']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'selected-owner');
    git(['add', '--', 'tracked.txt']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']);
    head = git(['rev-parse', 'HEAD']);
    db = new Database(':memory:'); db.pragma('foreign_keys=ON'); MigrationRunner.run(db);
    repo = new Repository(db);
    const now = new Date().toISOString();
    repo.createProject({ id: 'P', name: 'Selected consumer', description: null, repository_path: root, default_branch: 'main', status: 'RUNNING',
      contract: null, created_at: now, updated_at: now, started_at: now, completed_at: null }, captureRepositoryRoot(root));
    tasks = new TaskService(repo, new EventService(repo));
    tasks.createTask({ id: 'T', projectId: 'P', title: 'Real manager authority', priority: 'HIGH', risk: 'LOW' });
    decision = { protocol: 'manager.v1', message_id: 'manager-consumer-lifetime', project_id: 'P', task_id: 'T', decision: 'EXECUTE',
      priority: 'HIGH', risk: 'LOW', instructions: ['Implement selected task'], acceptance_criteria: [], constraints: [], review_issues: [],
      expected_task_state: 'PLANNED', expected_revision: 0 };
  });
  afterEach(() => {
    vi.restoreAllMocks(); db.close();
    if (!path.basename(root).startsWith('af-consumer-lifetime-') || fs.realpathSync.native(root) !== root) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('retains the real Git root through the manager decision commit and releases it after return', async () => {
    const git = vi.spyOn(GitService, 'getHeadSha');
    const transaction = repo.runInImmediateTransaction.bind(repo);
    const replacements: boolean[] = [];
    vi.spyOn(repo, 'runInImmediateTransaction').mockImplementation(callback => transaction(() => {
      const result = callback();
      let moved = false;
      try { fs.renameSync(path.join(root, '.git'), path.join(root, '.git-changed')); moved = true; } catch {}
      if (moved) fs.renameSync(path.join(root, '.git-changed'), path.join(root, '.git'));
      replacements.push(moved);
      return result;
    }));
    expect(await tasks.applyManagerDecision(decision, JSON.stringify(decision))).toMatchObject({ success: true });
    expect(git).toHaveBeenCalledTimes(1);
    expect(replacements).toEqual([false]);
    expect(repo.getTask('T')).toMatchObject({ state: 'CODING', base_sha: head });
    fs.renameSync(path.join(root, '.git'), path.join(root, '.git-changed'));
    fs.renameSync(path.join(root, '.git-changed'), path.join(root, '.git'));
  });

  it('rejects an unbound manager execution even when a historical task already carries a base SHA', async () => {
    db.prepare('UPDATE tasks SET base_sha=? WHERE id=?').run(head, 'T');
    db.prepare('DELETE FROM project_repository_identities WHERE project_id=?').run('P');
    const before = repo.getTask('T');
    const git = vi.spyOn(GitService, 'getHeadSha');
    expect(await tasks.applyManagerDecision(decision, JSON.stringify(decision))).toMatchObject({ success: false, errorCode: 'REPOSITORY_ROOT_UNBOUND' });
    expect(git).not.toHaveBeenCalled();
    expect(repo.getTask('T')).toEqual(before);
    expect(repo.getLatestAppliedManagerProtocolMessage('T', 'P')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_repository_identities').get()).toEqual({ count: 0 });
  });
});
