import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateContextPaths, MAX_TASK_CONTEXT_PATHS } from '../src/core/protocol/planProtocol';
import { parsePlanProtocol } from '../src/core/protocol/planProtocol';

/** #254: task-scoped coder context is validated against the repository before use. */
describe('task context path validation (#254)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-context-')));
    fs.mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'feature', 'a.ts'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    fs.mkdirSync(path.join(root, '.git'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts existing files and directories inside the repository, folding duplicates', () => {
    expect(validateContextPaths(root, ['src/feature', 'README.md', 'src/feature'])).toEqual({ ok: true, paths: ['src/feature', 'README.md'] });
  });

  it.each([
    ['an escaping path', '../outside', 'CONTEXT_PATH_INVALID'],
    ['an absolute path', 'C:/Windows', 'CONTEXT_PATH_INVALID'],
    ['a missing path', 'src/missing.ts', 'CONTEXT_PATH_MISSING'],
    ['a secret file', '.env', 'CONTEXT_PATH_DENIED'],
    ['the Git directory', '.git', 'CONTEXT_PATH_DENIED'],
  ])('rejects %s', (_name, candidate, reasonCode) => {
    expect(validateContextPaths(root, [candidate])).toMatchObject({ ok: false, reasonCode });
  });

  it('rejects a link, which could leave the repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-context-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return; // The platform cannot create the link.
    }
    expect(validateContextPaths(root, ['linked'])).toMatchObject({ ok: false, reasonCode: 'CONTEXT_PATH_LINK' });
    fs.rmSync(path.join(root, 'linked'), { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('bounds the number of paths', () => {
    for (let i = 0; i <= MAX_TASK_CONTEXT_PATHS; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    const many = Array.from({ length: MAX_TASK_CONTEXT_PATHS + 1 }, (_, i) => `f${i}.txt`);
    expect(validateContextPaths(root, many)).toMatchObject({ ok: false, reasonCode: 'CONTEXT_LIMIT_EXCEEDED' });
  });

  it('parses optional context_paths in a plan', () => {
    const plan = parsePlanProtocol(JSON.stringify({ protocol: 'plan.v1', message_id: 'p', project_id: 'project-1', contract_sha256: 'a'.repeat(64),
      tasks: [{ title: 'One', acceptance_criteria: ['done'], context_paths: ['src/feature'] }, { title: 'Two', acceptance_criteria: ['done'] }] }));
    expect(plan.success && plan.data.tasks.map((task) => task.context_paths)).toEqual([['src/feature'], []]);
  });
});
