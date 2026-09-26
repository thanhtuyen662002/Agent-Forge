import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const classifier = require('../scripts/ci-change-classifier.cjs') as {
  requiresPackage(paths: string[]): boolean;
  classifyPullRequest(base: string, head: string, cwd: string): boolean;
};

describe('exact-head CI path classification', () => {
  it('only exempts a closed set of documentation and process paths', () => {
    expect(classifier.requiresPackage(['README.md', 'AGENTS.md', 'docs/engineering/note.md', '.github/ISSUE_TEMPLATE/task.md'])).toBe(false);
    for (const path of ['src/main.ts', 'tests/check.test.ts', 'package.json', '.github/workflows/ci.yml',
      'scripts/build.cjs', 'docs/../src/main.ts', 'docs-extra/readme.md', '.github/dependabot.yml']) {
      expect(classifier.requiresPackage([path])).toBe(true);
    }
    expect(classifier.requiresPackage([])).toBe(true);
  });

  it('classifies actual Git diffs and sees the source side of a rename into docs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ci-scope-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init'); git('config', 'user.name', 'CI'); git('config', 'user.email', 'ci@example.invalid');
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src/runtime.ts'), 'export const runtime = true;\n');
      git('add', '.'); git('commit', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(root, 'README.md'), 'docs only\n');
      git('add', '.'); git('commit', '-m', 'docs');
      const docsHead = git('rev-parse', 'HEAD');
      expect(classifier.classifyPullRequest(base, docsHead, root)).toBe(false);
      fs.mkdirSync(path.join(root, 'docs'));
      git('mv', 'src/runtime.ts', 'docs/runtime.md'); git('commit', '-m', 'move runtime');
      expect(classifier.classifyPullRequest(base, git('rev-parse', 'HEAD'), root)).toBe(true);
      expect(() => classifier.classifyPullRequest('not-a-sha', docsHead, root)).toThrow('CI_SCOPE_INVALID_SHA');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps required job contexts and exact-head checks while skipping package work only for classified docs', () => {
    const ci = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');
    const fast = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/fast-pr.yml'), 'utf8');
    expect(ci).toContain('name: Validate (${{ matrix.os }}, Node ${{ matrix.node-version }})');
    expect(ci).toContain('name: Package Windows (windows-latest, Node 22.x)');
    expect(ci).toContain('if: always()');
    expect(ci).toContain("test '${{ needs.validate.result }}' = 'success'");
    expect(ci).toContain('git rev-parse HEAD');
    expect(ci).toContain('ci-change-classifier.cjs');
    expect(ci).toContain("if: needs.classify.outputs.package_required == 'true'");
    expect(ci).toContain('npm run package:win');
    expect(ci).toContain('npm run test:installed:win');
    expect(ci).not.toContain('      - name: Run test suite\n        run: npm test -- --maxWorkers=1');
    expect(fast).toContain('npx tsc --noEmit');
    expect(fast).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
    expect(fast).not.toContain('run: npm test');
    expect(fast).not.toContain('run: npm run build');
  });
});
