import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const watchdog = require('../scripts/watchdog-health-report.cjs') as {
  buildHealthReport(snapshot: unknown, options?: { now?: string; leaseHours?: number }): {
    ready: Array<{ number: number }>;
    executableReady: Array<{ number: number }>;
    staleDrafts: Array<{ number: number }>;
    duplicateClaims: Array<{ issueNumber: number; prs: number[] }>;
    pathConflicts: Array<{ left: number; right: number; files: string[] }>;
    checks: Array<{
      number: number;
      status: string;
      failures: Array<{ name: string }>;
      supersededCancelled: Array<{ name: string }>;
      stale: Array<{ name: string }>;
    }>;
    ciStalls: Array<{ number: number; kind: string }>;
  };
  renderHealthReport(result: unknown): string;
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW = '2026-09-28T12:00:00Z';

function taskBody(issue: number, status = 'READY', paths = ['scripts/watchdog-health-report.cjs'], blockedBy: number[] = []) {
  return `
\`\`\`yaml
AF_TASK_V1:
  priority: P1
  status: ${status}
  area: github-governance
  type: automation
  execution: WEB
  base_mode: MAIN
  blocked_by: [${blockedBy.join(', ')}]
  conflicts_with: []
  paths:
${paths.map((path) => `    - ${path}`).join('\n')}
  forbidden_paths: []
  risk: MEDIUM
\`\`\`

## Problem
Problem for #${issue}.
## Why this matters
The report must be actionable.
## Scope
Read-only health collection.
## Acceptance criteria
- [ ] Deterministic report.
## Required tests
- [ ] Unit tests.
## Non-goals
No mutations.
## Safety / invariants
Read-only GitHub permissions.
## Dependencies
None.
`;
}

function prBody(issue: number, paths: string[], phase = 'IMPLEMENTING') {
  return `
\`\`\`yaml
AF_PR_V1:
  issue: ${issue}
  phase: ${phase}
  base_sha: ${SHA_A}
  base_mode: MAIN
  paths:
${paths.map((path) => `    - ${path}`).join('\n')}
  blocked_by: []
  risk: MEDIUM
\`\`\`

Closes #${issue}
`;
}

function pullRequest(number: number, issue: number, files: string[], overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-09-28T11:00:00Z',
    updatedAt: '2026-09-28T11:00:00Z',
    headRefOid: SHA_A,
    body: prBody(issue, files),
    files,
    checks: [],
    ...overrides,
  };
}

function baseSnapshot(issues: unknown[], pullRequests: unknown[]) {
  return {
    repository: 'thanhtuyen662002/Agent-Forge',
    capturedAt: NOW,
    issues,
    pullRequests,
  };
}

describe('watchdog health parser', () => {
  it('counts AF_TASK_V1 READY Issues and separates open blocked dependencies', () => {
    const result = watchdog.buildHealthReport(baseSnapshot([
      { number: 80, title: 'Watchdog', body: taskBody(80) },
      { number: 81, title: 'Blocked task', body: taskBody(81, 'READY', ['docs/watchdog.md'], [84]) },
      { number: 84, title: 'Open dependency', body: taskBody(84, 'BLOCKED', ['docs/dependency.md']) },
      { number: 85, title: 'Non-contract issue', body: 'No AF_TASK_V1 here.' },
    ], []), { now: NOW });

    expect(result.ready.map((issue) => issue.number)).toEqual([80, 81]);
    expect(result.executableReady.map((issue) => issue.number)).toEqual([80]);
  });

  it('flags only old Draft PRs without a live wait as stale lease candidates', () => {
    const old = '2026-09-28T00:00:00Z';
    const result = watchdog.buildHealthReport(baseSnapshot([], [
      pullRequest(101, 80, ['scripts/watchdog-health-report.cjs'], {
        isDraft: true,
        updatedAt: old,
        body: prBody(80, ['scripts/watchdog-health-report.cjs'], 'IMPLEMENTING'),
        checks: [],
      }),
      pullRequest(102, 81, ['docs/watchdog.md'], {
        isDraft: true,
        updatedAt: old,
        body: prBody(81, ['docs/watchdog.md'], 'WAITING_CI'),
        checks: [{ id: 'ci-pending', name: 'CI', headSha: SHA_A, status: 'in_progress' }],
      }),
      pullRequest(103, 82, ['tests/watchdogHealthReport.test.ts'], {
        isDraft: true,
        updatedAt: '2026-09-28T11:30:00Z',
        body: prBody(82, ['tests/watchdogHealthReport.test.ts'], 'IMPLEMENTING'),
      }),
    ]), { now: NOW, leaseHours: 8 });

    expect(result.staleDrafts.map((pr) => pr.number)).toEqual([101]);
  });

  it('reports duplicate claims and material changed-file/path overlap', () => {
    const result = watchdog.buildHealthReport(baseSnapshot([], [
      pullRequest(201, 80, ['scripts/watchdog-health-report.cjs'], {
        body: prBody(80, ['scripts/**']),
      }),
      pullRequest(202, 80, ['scripts/watchdog-health-report.cjs'], {
        body: prBody(80, ['scripts/watchdog-health-report.cjs']),
      }),
    ]), { now: NOW });

    expect(result.duplicateClaims).toEqual([{ issueNumber: 80, prs: [201, 202] }]);
    expect(result.pathConflicts).toEqual([
      { left: 201, right: 202, files: ['scripts/watchdog-health-report.cjs'], declaredPaths: [] },
    ]);
  });

  it('binds check status to the exact PR head and excludes superseded cancelled runs from failures', () => {
    const result = watchdog.buildHealthReport(baseSnapshot([], [
      pullRequest(301, 80, ['docs/watchdog.md'], {
        checks: [
          { id: 'old-ci', name: 'CI', headSha: SHA_B, status: 'completed', conclusion: 'failure' },
          { id: 'cancelled-ci', name: 'CI', headSha: SHA_A, status: 'completed', conclusion: 'cancelled', completedAt: '2026-09-28T11:00:00Z' },
          { id: 'new-ci', name: 'CI', headSha: SHA_A, status: 'completed', conclusion: 'success', completedAt: '2026-09-28T11:10:00Z' },
          { id: 'lint', name: 'Lint', headSha: SHA_A, status: 'in_progress' },
          { id: 'build', name: 'Build', headSha: SHA_A, status: 'completed', conclusion: 'failure' },
          { id: 'cancelled-only', name: 'Docs', headSha: SHA_A, status: 'completed', conclusion: 'cancelled' },
        ],
      }),
    ]), { now: NOW });
    const checks = result.checks[0];

    expect(checks.status).toBe('FAIL');
    expect(checks.failures.map((check) => check.name)).toEqual(['Build']);
    expect(checks.supersededCancelled.map((check) => check.name)).toEqual(['CI']);
    expect(checks.stale.map((check) => check.name)).toEqual(['CI']);
    expect(result.ciStalls).toEqual(expect.arrayContaining([
      { number: 301, kind: 'PENDING', detail: 'Lint' },
      { number: 301, kind: 'CANCELLED', detail: 'Docs has no newer replacement' },
    ]));
  });

  it('renders the read-only report sections and cancellation safety statement', () => {
    const result = watchdog.buildHealthReport(baseSnapshot([
      { number: 80, title: 'Watchdog', body: taskBody(80) },
    ], [pullRequest(401, 80, ['docs/watchdog.md'])]), { now: NOW });
    const report = watchdog.renderHealthReport(result);

    expect(report).toContain('# Agent Forge watchdog health report');
    expect(report).toContain('READY `AF_TASK_V1` Issues: **1**');
    expect(report).toContain('## Open PR exact-head checks');
    expect(report).toContain('## Duplicate Issue claims');
    expect(report).toContain('## Path-scope conflicts');
    expect(report).toContain('## CI stalls');
    expect(report).toContain('A cancelled check is never counted as a failure');
  });
});
