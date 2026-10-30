import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from '../src/core/database/repositories';
import type { ExecutionAuthorization } from '../src/core/types/domain';
import { collectCarriedFiles } from '../src/core/services/RevisionCarryForward';

/** #352: a fix revision builds on the files its task's previous revision wrote. */
describe('revision carry-forward selection', () => {
  let tmp: string;
  let managedRoot: string;
  let current: string;
  let runs: Array<Record<string, unknown>>;
  const repo = () => ({
    getProjectEventsOfTypes: () => runs.map((payload, index) => ({ id: `e${index}`, structured_payload: payload })),
  }) as unknown as Repository;
  const auth = { id: 'auth-now', project_id: 'P', task_id: 'T', repository_head_sha: 'a'.repeat(40) } as ExecutionAuthorization;
  const worktree = (name: string, files: Record<string, string>) => {
    const root = path.join(managedRoot, name);
    for (const [relative, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), text);
    }
    return root;
  };
  const carried = () => collectCarriedFiles(repo(), auth, current, managedRoot)
    .map((file) => `${file.relativePath}=${file.content.toString('utf8')}`);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-carry-'));
    managedRoot = path.join(tmp, 'managed');
    current = worktree('afw-current', { 'src/shared.ts': 'main\n' });
    runs = [];
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('carries the latest earlier run with changes, skipping runs without changes and deleted files', () => {
    const older = worktree('afw-older', { 'src/old.ts': 'old\n' });
    const latest = worktree('afw-latest', { 'src/render/plans.ts': 'plans\n', 'src/shared.ts': 'edited\n' });
    runs = [
      { authorizationId: 'auth-blocked', worktree: worktree('afw-blocked', {}), headSha: 'a'.repeat(40), changedFiles: [] },
      { authorizationId: 'auth-1', worktree: latest, headSha: 'a'.repeat(40), changedFiles: ['src/render/plans.ts', 'src/shared.ts', 'src/deleted.ts'] },
      { authorizationId: 'auth-0', worktree: older, headSha: 'a'.repeat(40), changedFiles: ['src/old.ts'] },
    ];
    expect(carried()).toEqual(['src/render/plans.ts=plans\n', 'src/shared.ts=edited\n']);
  });

  it('carries only files absent at the new HEAD once HEAD has moved', () => {
    const latest = worktree('afw-latest', { 'src/render/plans.ts': 'plans\n', 'src/shared.ts': 'stale edit\n' });
    runs = [{ authorizationId: 'auth-1', worktree: latest, headSha: 'b'.repeat(40), changedFiles: ['src/render/plans.ts', 'src/shared.ts'] }];
    expect(carried()).toEqual(['src/render/plans.ts=plans\n']);
  });

  it('never reads a worktree outside the managed root, its own run, or paths that escape', () => {
    const outside = path.join(tmp, 'elsewhere');
    fs.mkdirSync(path.join(outside, 'src'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'src', 'x.ts'), 'x\n');
    runs = [{ authorizationId: 'auth-1', worktree: outside, headSha: 'a'.repeat(40), changedFiles: ['src/x.ts'] }];
    expect(carried()).toEqual([]);

    runs = [{ authorizationId: 'auth-now', worktree: worktree('afw-self', { 'src/x.ts': 'x\n' }), headSha: 'a'.repeat(40), changedFiles: ['src/x.ts'] }];
    expect(carried()).toEqual([]);

    const latest = worktree('afw-latest', { 'src/ok.ts': 'ok\n' });
    runs = [{ authorizationId: 'auth-1', worktree: latest, headSha: 'a'.repeat(40), changedFiles: ['../afw-current/src/shared.ts', '.git/config', 'src/ok.ts'] }];
    expect(carried()).toEqual(['src/ok.ts=ok\n']);
  });

  it('carries nothing for a task without earlier changes', () => {
    expect(carried()).toEqual([]);
  });
});
