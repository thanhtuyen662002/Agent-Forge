import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewContextFiles } from '../src/core/services/ReviewContext';

/** #374: the coder's new files must not push the reviewer's context over the workspace limit. */
describe('review context', () => {
  let root: string;
  const limits = { maxFiles: 6, maxTraversalEntries: 64 };
  const write = (relative: string) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), '// fixture\n');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-review-ctx-'));
    for (const file of ['AGENTS.md', 'src/a.ts', 'src/b.ts', 'test/a.test.ts', 'node_modules/pkg/index.js']) write(file);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps an authorized context that still fits', () => {
    write('src/new.ts');
    expect(reviewContextFiles(root, ['AGENTS.md', 'src', 'test'], ['src/new.ts'], limits)).toEqual(['AGENTS.md', 'src', 'test']);
  });

  it('reviews the listed files and the changed files when new files overflow the directories', () => {
    for (const file of ['src/new1.ts', 'src/new2.ts', 'test/new.test.ts']) write(file);
    const changed = ['src/a.ts', 'src/new1.ts', 'src/new2.ts', 'src/deleted.ts', 'test/new.test.ts'];
    expect(reviewContextFiles(root, ['AGENTS.md', 'src', 'test'], changed, limits))
      .toEqual(['AGENTS.md', 'src/a.ts', 'src/new1.ts', 'src/new2.ts', 'test/new.test.ts']);
  });

  it('never returns more files than the limit', () => {
    const changed = Array.from({ length: 10 }, (_, index) => `src/n${index}.ts`);
    changed.forEach(write);
    expect(reviewContextFiles(root, ['src'], changed, limits)).toHaveLength(limits.maxFiles);
  });

  it('also falls back when the directories hold too many entries', () => {
    expect(reviewContextFiles(root, ['AGENTS.md', 'src'], ['src/b.ts'], { maxFiles: 50, maxTraversalEntries: 1 }))
      .toEqual(['AGENTS.md', 'src/b.ts']);
  });
});
