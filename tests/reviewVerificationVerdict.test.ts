import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { parseTestMetrics } from '../src/core/services/VerificationService';
import type { Project, Task, TestRun } from '../src/core/types/domain';

const createdAt = '2026-10-10T00:00:00.000Z';
const project: Project = {
  id: 'review-verdict-project', name: 'Review verdict regression', description: null,
  repository_path: 'fixture-repository', default_branch: 'main', status: 'RUNNING',
  contract: null, created_at: createdAt, updated_at: createdAt, started_at: null, completed_at: null,
};
const task: Task = {
  id: 'review-verdict-task', project_id: project.id, milestone_id: null,
  title: 'Preserve verification observations', description: null, state: 'REVIEW_READY',
  paused_from_state: null, priority: 'MEDIUM', risk: 'LOW', assigned_agent_id: null,
  revision_count: 0, max_revisions: 3, base_sha: null, current_sha: null,
  progress_cache_percent: 0, progress_computed_at: null, acceptance_criteria: [], constraints: [],
  created_at: createdAt, updated_at: createdAt,
};

function testRun(stdout: string, exitCode: number): TestRun {
  const metrics = parseTestMetrics(stdout, exitCode);
  return {
    id: 'review-verdict-run', task_id: task.id, command: 'node fixture-verification.js',
    passed_count: metrics.passedCount, failed_count: metrics.failedCount,
    skipped_count: metrics.skippedCount, duration_ms: 5, exit_code: exitCode,
    evidence_id: 'review-verdict-evidence', created_at: createdAt,
  };
}

function render(run: TestRun | null): string {
  return PackageGenerator.generateReviewPackage(project, task, null, '', '', run);
}

describe('Legacy review verification verdict truth', () => {
  it('retains actual zero exit while rendering reported failed tests as FAILED', () => {
    const child = spawnSync(process.execPath, ['-e',
      'process.stdout.write("# pass 2\\n# fail 1\\n# skipped 3\\n"); process.exit(0);',
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const run = testRun(child.stdout, child.status!);
    expect(run).toMatchObject({ exit_code: 0, passed_count: 2, failed_count: 1, skipped_count: 3 });
    const review = render(run);
    expect(review).toContain('**Authoritative Verdict**: 🔴 FAILED (Exit Code: `0`)');
    expect(review).toContain('**Metrics**: 2 Passed | 1 Failed | 3 Skipped');
    expect(review).toContain('**Evidence Reference**: `review-verdict-evidence`');
    expect(run.exit_code).toBe(0);
  });

  it('preserves ordinary zero-exit success with no reported failures', () => {
    const review = render(testRun('# pass 2\n# fail 0\n# skipped 1\n', 0));
    expect(review).toContain('**Authoritative Verdict**: 🟢 PASSED (Exit Code: `0`)');
    expect(review).toContain('**Metrics**: 2 Passed | 0 Failed | 1 Skipped');
  });

  it('retains failure on a nonzero exit even with zero reported failed tests', () => {
    const review = render(testRun('# pass 2\n# fail 0\n', 2));
    expect(review).toContain('**Authoritative Verdict**: 🔴 FAILED (Exit Code: `2`)');
    expect(review).toContain('**Metrics**: 2 Passed | 0 Failed | 0 Skipped');
  });

  it('keeps missing test evidence explicitly unavailable', () => {
    const review = render(null);
    expect(review).toContain('[TEST EVIDENCE UNAVAILABLE / NOT RUN / ERROR]');
    expect(review).not.toContain('**Authoritative Verdict**:');
    expect(review).not.toContain('**Metrics**:');
  });
});
