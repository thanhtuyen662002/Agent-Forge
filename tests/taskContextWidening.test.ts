import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from '../src/core/database/repositories';
import { MAX_CONTEXT_ADDED_PER_FAILURE, widenTaskContext } from '../src/core/services/TaskContextWidening';

/** #328: repository files a failure names join the task's context for the next run. */
describe('task context widening', () => {
  let root: string;
  let context: string[];
  const repo = () => ({
    getProjectMetadata: () => ({ repository_path: root }),
    getTaskContextPaths: () => [...context],
    setTaskContextPaths: (_project: string, _task: string, paths: string[]) => { context = paths; },
  }) as unknown as Repository;
  const write = (relative: string) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), '// fixture\n');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-widen-'));
    for (const file of ['src/paths.ts', 'src/cli.ts', 'src/migrations.ts', 'test/cli-ref.test.ts', 'test/cli-project.test.ts']) write(file);
    context = ['src/paths.ts'];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('adds existing files a failing test run, coder blockers and a refused sync name', () => {
    const added = widenTaskContext(repo(), 'P', 'T', [
      'test at test\\cli-ref.test.ts:28:1\n  at TestContext (file:///C:/elsewhere/worktree/test/cli-ref.test.ts:36:10)',
      'Workspace thiếu src/migrations.ts; thiếu các test cli-project.test.ts và src/does-not-exist.ts',
      'WORKSPACE_SYNC_OUT_OF_SCOPE: provider created a file outside its authorized directories: src/cli.ts',
    ]);
    expect(added).toEqual(['test/cli-ref.test.ts', 'src/migrations.ts', 'test/cli-project.test.ts', 'src/cli.ts']);
    expect(context).toEqual(['src/paths.ts', ...added]);
    expect(widenTaskContext(repo(), 'P', 'T', ['src/cli.ts'])).toEqual([]); // Already there.
  });

  it('never adds paths outside the repository, dependencies, or anything for a task without explicit context', () => {
    write('node_modules/pkg/index.js');
    expect(widenTaskContext(repo(), 'P', 'T', ['../outside.ts', 'node_modules/pkg/index.js', '.git/config.json'])).toEqual([]);
    expect(context).toEqual(['src/paths.ts']);
    context = [];
    expect(widenTaskContext(repo(), 'P', 'T', ['src/cli.ts'])).toEqual([]);
    expect(context).toEqual([]);
  });

  it('adds at most a bounded number of files at once', () => {
    const names = Array.from({ length: MAX_CONTEXT_ADDED_PER_FAILURE + 4 }, (_, index) => `src/file${index}.ts`);
    names.forEach(write);
    expect(widenTaskContext(repo(), 'P', 'T', [names.join(' ')])).toHaveLength(MAX_CONTEXT_ADDED_PER_FAILURE);
  });
});
