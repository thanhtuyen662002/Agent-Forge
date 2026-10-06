import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { evaluateWindowsTestGate: gate } = require('../scripts/ci-windows-test-gate.cjs');
const yaml = require('js-yaml');
const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('complete Windows suite aggregation', () => {
  it('only accepts complete runtime success or an explicitly classified documentation skip', () => {
    expect(gate({ classifyResult: 'success', packageRequired: 'true', shardsResult: 'success' }).ok).toBe(true);
    expect(gate({ classifyResult: 'success', packageRequired: 'false', shardsResult: 'skipped' }).ok).toBe(true);
  });

  it.each(['failure', 'cancelled', 'skipped', 'in_progress', '', undefined])('rejects incomplete runtime matrix result %s', (shardsResult) => {
    expect(gate({ classifyResult: 'success', packageRequired: 'true', shardsResult }).ok).toBe(false);
  });

  it.each(['failure', 'cancelled', 'skipped', '', undefined])('rejects upstream classification %s even with successful shards', (classifyResult) => {
    for (const packageRequired of ['true', 'false']) {
      expect(gate({ classifyResult, packageRequired, shardsResult: 'success' }).ok).toBe(false);
    }
  });

  it.each([true, false, '', undefined, 'TRUE', 'false\n', 'attacker-controlled'])('rejects malformed package classification %s', (packageRequired) => {
    expect(gate({ classifyResult: 'success', packageRequired, shardsResult: 'success' }).ok).toBe(false);
  });

  it.each(['success', 'failure', 'cancelled', '', undefined])('rejects an unexpected documentation matrix result %s', (shardsResult) => {
    expect(gate({ classifyResult: 'success', packageRequired: 'false', shardsResult }).ok).toBe(false);
  });

  it('exits nonzero for missing CLI inputs without echoing input values', () => {
    const script = path.resolve('scripts/ci-windows-test-gate.cjs');
    const run = (flag: string, result: string) => spawnSync(process.execPath, [script], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, CI_CLASSIFY_RESULT: 'success', CI_PACKAGE_REQUIRED: flag, CI_WINDOWS_SHARDS_RESULT: result },
    });
    expect(run('true', 'success').status).toBe(0);
    expect(run('false', 'skipped').status).toBe(0);
    expect(run('true', '').status).toBe(1);
    const invalid = run('private-input-must-not-appear', 'success');
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('CI_CLASSIFICATION_INVALID\n');
    expect(invalid.stderr).toBe('');
  });

  it('partitions the full suite into four isolated single-worker protected runs', () => {
    const shards = workflow.jobs['windows-test-shards'];
    expect(shards['runs-on']).toBe('windows-latest');
    expect(shards.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    expect(shards.strategy['fail-fast']).toBe(false);
    const run = shards.steps.find((step: any) => step.name === 'Run complete suite shard');
    expect(run.run).toBe('npm test -- --shard=${{ matrix.shard }}/4');
    expect(run.if).toBeUndefined();
    expect(run['continue-on-error']).toBeUndefined();
    expect(shards['continue-on-error']).toBeUndefined();
    expect(run.env.AGENTFORGE_TEST_SINGLE_RUN).toBe('1');
    expect(run.env.AGENTFORGE_TEST_FILES).toBe('');
    expect(run.env.AGENTFORGE_TEST_PHASE).toBe('');
    expect(shards.steps.some((step: any) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(false);
  });

  it('preserves required contexts, independent Ubuntu and fail-closed package dependencies', () => {
    const jobs = workflow.jobs;
    expect(jobs.validate.name).toBe('Validate (${{ matrix.os }}, Node ${{ matrix.node-version }})');
    expect(jobs.validate.strategy.matrix.os).toEqual(['ubuntu-latest']);
    expect(jobs.validate.needs).toBe('classify');
    const windows = jobs['validate-windows'];
    expect(windows.name).toBe('Validate (windows-latest, Node 22.x)');
    expect(windows.needs).toEqual(['classify', 'windows-test-shards']);
    expect(windows.if).toBe('always()');
    const gateStep = windows.steps.find((step: any) => step.name === 'Require complete Windows suite');
    expect(gateStep.if).toBeUndefined();
    expect(gateStep.run).toBe('node scripts/ci-windows-test-gate.cjs');
    expect(gateStep.env).toEqual({
      CI_CLASSIFY_RESULT: '${{ needs.classify.result }}',
      CI_PACKAGE_REQUIRED: '${{ needs.classify.outputs.package_required }}',
      CI_WINDOWS_SHARDS_RESULT: '${{ needs.windows-test-shards.result }}',
    });
    expect(windows.steps.some((step: any) => step.run === 'npm run build')).toBe(true);
    expect(jobs['package-windows'].name).toBe('Package Windows (windows-latest, Node 22.x)');
    expect(jobs['package-windows'].needs).toEqual(['classify', 'validate', 'validate-windows']);
    const upstream = jobs['package-windows'].steps.find((step: any) => step.name === 'Require upstream gates');
    expect(upstream.run).toContain("test '${{ needs.validate.result }}' = 'success'");
    expect(upstream.run).toContain("test '${{ needs.validate-windows.result }}' = 'success'");
    expect(jobs['package-windows'].steps.some((step: any) => step.run?.includes('npm run test:installed:win'))).toBe(true);
  });

  it('binds every runner to the exact source without write permission or checkout credentials', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(workflow.jobs) as any[]) {
      const checkout = job.steps.find((step: any) => step.name === 'Checkout exact source');
      expect(checkout.with.ref).toBe("${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}");
      expect(checkout.with['persist-credentials']).toBe(false);
      expect(job.steps.some((step: any) => typeof step.run === 'string' && step.run.includes('git rev-parse HEAD'))).toBe(true);
    }
  });
});
