import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const profile = require('../scripts/windows-test-profile.cjs');
const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts', 'tests/new.test.ts'];
// Synthetic metadata is test input; it is never evidence for a successful CI.
const metadata = () => ({ schemaVersion: 1, algorithm: 'vitest-default-sha1-four-shards-v1', vitestVersion: '4.1.11',
  source: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) }, run: { id: '123', attempt: 1 }, platform: 'win32', inventory: [...files].sort() });
const receipts = () => profile.partition(files).map((assigned: string[], index: number) => ({ ...metadata(), shard: index + 1,
  modules: assigned.map(file => ({ file, state: 'passed', durationMs: 12, prepareMs: 3, collectMs: 2, setupMs: 1, environmentMs: 0 })) }));
const fixtureProfile = () => ({ schemaVersion: 2, observations: [1, 2].map(index => {
  const input = receipts();
  for (const receipt of input) receipt.run.id = String(122 + index);
  return { receipt: profile.aggregate(input, { ...metadata(), run: { id: String(122 + index), attempt: 1 } }),
    jobs: [1, 2, 3, 4].map(shard => ({ shard, jobId: String(index * 1000 + shard), durationSeconds: 1 })),
    artifact: { id: String(index), receiptSha256: String(index).repeat(64) }, conclusion: 'SUCCESS' };
}) });

describe('bounded public Windows timing evidence', () => {
  it('covers every discovered file once, including new files, deterministically without timing history', () => {
    const assignment = profile.partition(files);
    expect(assignment.flat().sort()).toEqual([...files].sort());
    expect(assignment.every((shard: string[]) => shard.length > 0)).toBe(true);
    expect(profile.partition([...files].reverse())).toEqual(assignment);
    expect(profile.aggregate(receipts(), metadata()).shards.flatMap((shard: any) => shard.modules.map((row: any) => row.file)).sort()).toEqual([...files].sort());
  });

  it('balances measured bottlenecks with complete deterministic assignment and conservative new/renamed-file costs', () => {
    const original = profile.partition(files);
    const weights = Object.fromEntries(files.map(file => [file, original[0].includes(file) ? 120000 : 1000]));
    const balanced = profile.balancedPartition(files, weights);
    const load = (groups: string[][]) => Math.max(...groups.map(group => group.reduce((sum, file) => sum + weights[file], 0)));
    expect(load(balanced)).toBeLessThan(load(original));
    expect(balanced.flat().sort()).toEqual([...files].sort());
    expect(profile.balancedPartition([...files].reverse(), weights)).toEqual(balanced);
    const current = [...files.filter(file => file !== 'tests/new.test.ts'), 'tests/renamed.test.ts', 'tests/unprofiled.test.ts'];
    const plan = profile.timingPlan(fixtureProfile(), current);
    expect(plan.weights['tests/renamed.test.ts']).toBe(12);
    expect(plan.weights['tests/unprofiled.test.ts']).toBe(12);
    const assignment = profile.balancedPartition(current, plan.weights);
    expect(assignment.flat().sort()).toEqual([...current].sort());
    expect(assignment.every((group: string[]) => group.length > 0)).toBe(true);
    expect(plan.weights['tests/new.test.ts']).toBeUndefined();
  });

  it.each(['one-observation', 'failed', 'duplicate-run', 'duplicate-job', 'unknown-file', 'wrong-source', 'bad-artifact', 'raw-diagnostic'])('rejects %s historical profile evidence', variant => {
    const input = fixtureProfile();
    if (variant === 'one-observation') input.observations.pop();
    if (variant === 'failed') input.observations[0].conclusion = 'FAILURE';
    if (variant === 'duplicate-run') input.observations[1] = structuredClone(input.observations[0]);
    if (variant === 'duplicate-job') input.observations[1].jobs[0].jobId = input.observations[0].jobs[0].jobId;
    if (variant === 'unknown-file') input.observations[0].receipt.shards[0].modules[0].file = 'tests/unknown.test.ts';
    if (variant === 'wrong-source') input.observations[0].receipt.shards[0].source.commitSha = 'c'.repeat(40);
    if (variant === 'bad-artifact') input.observations[0].artifact.receiptSha256 = 'malformed';
    if (variant === 'raw-diagnostic') (input.observations[0] as any).diagnostics = 'AF_TEST_ONLY_PRIVATE_DIAGNOSTIC';
    expect(() => profile.timingPlan(input, files)).toThrow('CI_WINDOWS_PROFILE_INVALID');
  });

  it.each(['zero-cost', 'oversized-cost', 'extra-file', 'changed-profile', 'changed-plan', 'old-algorithm'])('rejects %s weighted receipts rather than manufacturing a complete aggregate', variant => {
    const expected = { ...metadata(), algorithm: 'vitest-max-observed-lpt-four-shards-v1', plan: profile.timingPlan(fixtureProfile(), files) };
    const input = profile.assignedFiles(expected).map((assigned: string[], index: number) => ({ ...structuredClone(expected), shard: index + 1,
      modules: assigned.map(file => ({ file, state: 'passed', durationMs: 12, prepareMs: 3, collectMs: 2, setupMs: 1, environmentMs: 0 })) }));
    if (variant === 'zero-cost') input[0].plan.weights[files[0]] = 0;
    if (variant === 'oversized-cost') input[0].plan.weights[files[0]] = 6 * 60 * 60 * 1000 + 1;
    if (variant === 'extra-file') input[0].plan.weights['tests/unknown.test.ts'] = 1;
    if (variant === 'changed-profile') input[0].plan.profileSha256 = 'c'.repeat(64);
    if (variant === 'changed-plan') input[0].plan.weights[files[0]]++;
    if (variant === 'old-algorithm') { input[0].algorithm = 'vitest-default-sha1-four-shards-v1'; delete input[0].plan; }
    expect(() => profile.aggregate(input, expected)).toThrow('CI_WINDOWS_PROFILE_INVALID');
  });

  it.each([
    ['duplicate', [...files, files[0]]], ['empty-shard', files.slice(0, 3)],
    ['outside', [...files, '../private.test.ts']], ['machine-path', [...files, 'C:/private.test.ts']],
    ['unknown-type', [...files, 'tests/private.log']], ['oversized', Array.from({ length: 4097 }, (_, index) => `tests/f${index}.test.ts`)],
  ])('rejects unsafe %s discovery without echoing its values', (_label, input) => {
    expect(() => profile.partition(input)).toThrow('CI_WINDOWS_PROFILE_INVALID');
  });

  it.each(['missing', 'duplicate', 'unknown', 'failed', 'nan', 'negative', 'oversized', 'raw-diagnostic', 'wrong-head', 'wrong-type-head', 'wrong-run', 'wrong-inventory'])('rejects %s receipt data', variant => {
    const input = receipts();
    const receipt = input[0];
    if (variant === 'missing') receipt.modules.pop();
    if (variant === 'duplicate') receipt.modules.push(receipt.modules[0]);
    if (variant === 'unknown') receipt.modules[0].file = 'tests/unknown.test.ts';
    if (variant === 'failed') receipt.modules[0].state = 'failed';
    if (variant === 'nan') receipt.modules[0].durationMs = NaN;
    if (variant === 'negative') receipt.modules[0].durationMs = -1;
    if (variant === 'oversized') receipt.modules[0].durationMs = 6 * 60 * 60 * 1000 + 1;
    if (variant === 'raw-diagnostic') receipt.modules[0].notes = 'AF_TEST_ONLY_PRIVATE_DIAGNOSTIC';
    if (variant === 'wrong-head') receipt.source.commitSha = 'c'.repeat(40);
    if (variant === 'wrong-type-head') receipt.source.commitSha = ['a'.repeat(40)];
    if (variant === 'wrong-run') receipt.run.id = '999';
    if (variant === 'wrong-inventory') receipt.inventory = receipt.inventory.slice(1);
    expect(() => profile.aggregate(input, metadata())).toThrow('CI_WINDOWS_PROFILE_INVALID');
  });

  it('rejects missing/duplicated/future shard attempts and handles genuine same-source partial reruns', () => {
    expect(() => profile.aggregate(receipts().slice(0, 3), metadata())).toThrow('CI_WINDOWS_PROFILE_INVALID');
    expect(() => profile.aggregate([...receipts(), receipts()[0]], metadata())).toThrow('CI_WINDOWS_PROFILE_INVALID');
    const retried = receipts()[0]; retried.run.attempt = 2;
    expect(() => profile.aggregate([...receipts(), retried], metadata())).toThrow('CI_WINDOWS_PROFILE_INVALID');
    const current = metadata(); current.run.attempt = 2;
    const result = profile.aggregate([retried, ...receipts()], current);
    expect(result.shards[0].run.attempt).toBe(2);
    expect(result.shards.slice(1).every((shard: any) => shard.run.attempt === 1)).toBe(true);
  });

  it('requires the complete single-worker shard invocation without filters or phase overrides', () => {
    const env = { AGENTFORGE_TEST_SINGLE_RUN: '1', AGENTFORGE_TEST_FILES: '', AGENTFORGE_TEST_PHASE: '' };
    expect(profile.shardArgument(['--shard=4/4'], env)).toBe(4);
    for (const args of [[], ['--shard=0/4'], ['--shard=1/3'], ['--shard=1/4', '--testNamePattern=one'], ['--exclude=tests/a.test.ts']]) {
      expect(() => profile.shardArgument(args, env)).toThrow('CI_WINDOWS_PROFILE_INVALID');
    }
    for (const override of [{ AGENTFORGE_TEST_SINGLE_RUN: '0' }, { AGENTFORGE_TEST_FILES: files[0] }, { AGENTFORGE_TEST_PHASE: 'parallel' }]) {
      expect(() => profile.shardArgument(['--shard=1/4'], { ...env, ...override })).toThrow('CI_WINDOWS_PROFILE_INVALID');
    }
  });

  it('bounds JSON before parsing and rejects unknown metadata rather than persisting diagnostics', () => {
    expect(() => profile.parse('x'.repeat(profile.MAX_BYTES + 1))).toThrow('CI_WINDOWS_PROFILE_INVALID');
    expect(() => profile.parse('AF_TEST_ONLY_INVALID_JSON')).toThrow('CI_WINDOWS_PROFILE_INVALID');
    expect(() => profile.context({ ...metadata(), diagnostics: 'AF_TEST_ONLY_PRIVATE_DIAGNOSTIC' })).toThrow('CI_WINDOWS_PROFILE_INVALID');
  });

  it.skipIf(process.platform !== 'win32')('collects all four real protected fixture shards and aggregates only whitelisted fields', () => {
    const repository = path.resolve('.');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-windows-profile-')));
    const vitestLink = path.join(root, 'node_modules', 'vitest');
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      fs.symlinkSync(path.join(repository, 'node_modules', 'vitest'), vitestLink, 'junction');
      fs.mkdirSync(path.join(root, 'tests')); fs.mkdirSync(path.join(root, 'scripts'));
      for (const name of ['run-test-suite.cjs', 'test-output-sanitizer.cjs', 'windows-test-profile.cjs', 'windows-test-sequencer.mjs', 'windows-test-profile.json']) fs.copyFileSync(path.join(repository, 'scripts', name), path.join(root, 'scripts', name));
      fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
      const hook = path.join(repository, 'tests/testOutputSanitizer.ts').replace(/\\/g, '/');
      fs.writeFileSync(path.join(root, 'vite.config.mjs'), [
        "import WindowsTestSequencer from './scripts/windows-test-sequencer.mjs';",
        "const enabled = process.env.AGENTFORGE_WINDOWS_PROFILE_SEQUENCE === '1'; delete process.env.AGENTFORGE_WINDOWS_PROFILE_SEQUENCE;",
        `export default { test: { setupFiles: [${JSON.stringify(hook)}], ...(enabled ? { sequence: { sequencer: WindowsTestSequencer } } : {}) } };`,
      ].join('\n'));
      for (const letter of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(root, 'tests', `${letter}.test.ts`), "import { it, expect } from 'vitest'; it('AF_TEST_ONLY_PRIVATE_DIAGNOSTIC', () => expect(true).toBe(true));\n");
      fs.writeFileSync(path.join(root, 'tests/a.test.ts'), [
        "import { it, expect } from 'vitest'; import { spawnSync } from 'node:child_process';",
        "it('nested protected runner remains independent of parent timing', () => {",
        "  const child = spawnSync(process.execPath, ['scripts/run-test-suite.cjs'], { cwd: process.cwd(), env: { ...process.env, AGENTFORGE_TEST_FILES: 'tests/b.test.ts' }, encoding: 'utf8', timeout: 30000 });",
        "  expect(child.status).toBe(0);",
        "});",
      ].join('\n'));
      git(['init']); git(['add', '.']); git(['-c', 'user.name=AF Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic timing fixture']);
      const env = { ...process.env, AGENTFORGE_WINDOWS_TEST_PROFILE: '1', AGENTFORGE_PROFILE_SOURCE_SHA: git(['rev-parse', 'HEAD']),
        GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', AGENTFORGE_TEST_SINGLE_RUN: '1', AGENTFORGE_TEST_FILES: '', AGENTFORGE_TEST_PHASE: '' };
      const collected = [];
      for (const shard of [1, 2, 3, 4]) {
        const result = spawnSync(process.execPath, ['scripts/run-test-suite.cjs', `--shard=${shard}/4`], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: profile.MAX_BYTES });
        expect(result.status).toBe(0);
        const receipt = JSON.parse(fs.readFileSync(path.join(root, profile.PROFILE_DIR, `shard-${shard}.json`), 'utf8'));
        const text = JSON.stringify(receipt);
        expect(text.includes('AF_TEST_ONLY_PRIVATE_DIAGNOSTIC')).toBe(false);
        expect(text.includes(root)).toBe(false);
        expect(receipt.modules).toHaveLength(1);
        collected.push(receipt);
        const incoming = path.join(root, profile.PROFILE_DIR, 'incoming', `agentforge-windows-profile-123-1-${shard}`);
        fs.mkdirSync(incoming, { recursive: true });
        fs.writeFileSync(path.join(incoming, `shard-${shard}.json`), JSON.stringify(receipt));
      }
      expect(collected.flatMap(receipt => receipt.modules.map((row: any) => row.file)).sort()).toEqual(['a', 'b', 'c', 'd'].map(letter => `tests/${letter}.test.ts`));
      const result = spawnSync(process.execPath, ['scripts/windows-test-profile.cjs', 'aggregate'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 45000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('CI_WINDOWS_PROFILE_COMPLETE\n');
      const combined = JSON.parse(fs.readFileSync(path.join(root, profile.PROFILE_DIR, 'combined.json'), 'utf8'));
      expect(combined.shards).toHaveLength(4);
      const failedFile = collected[0].modules[0].file;
      fs.writeFileSync(path.join(root, failedFile), "import { it, expect } from 'vitest'; it('fixture failure', () => expect(false).toBe(true));\n");
      git(['add', failedFile]); git(['-c', 'user.name=AF Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic failed test']);
      const failedEnv = { ...env, AGENTFORGE_PROFILE_SOURCE_SHA: git(['rev-parse', 'HEAD']) };
      const failed = spawnSync(process.execPath, ['scripts/run-test-suite.cjs', '--shard=1/4'], { cwd: root, env: failedEnv, encoding: 'utf8', windowsHide: true, timeout: 45000 });
      expect(failed.status).not.toBe(0);
      expect(fs.existsSync(path.join(root, profile.PROFILE_DIR, 'shard-1.json'))).toBe(false);
      const stale = spawnSync(process.execPath, ['scripts/windows-test-profile.cjs', 'aggregate'], { cwd: root, env: failedEnv, encoding: 'utf8', windowsHide: true, timeout: 45000 });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toBe('CI_WINDOWS_PROFILE_INVALID\n');
    } finally {
      if (!path.basename(root).startsWith('af-windows-profile-') || fs.realpathSync.native(root) !== root) throw new Error('FIXTURE_BOUNDARY_CHANGED');
      if (fs.existsSync(vitestLink)) fs.unlinkSync(vitestLink);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
