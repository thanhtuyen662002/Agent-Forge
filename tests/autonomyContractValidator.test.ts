import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const validator = require('../scripts/autonomy-contract-validator.cjs') as {
  CONTRACT_EFFECTIVE_AT: string;
  closingIssueNumbers(body: string): number[];
  validateEvent(event: unknown, options?: {
    eventName?: string;
    repository?: string;
    token?: string;
    fetchImpl?: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  }): Promise<{ ok: boolean; status: string; errors: string[] }>;
  validateIssueContract(body: string, context?: { createdAt?: string }): {
    ok: boolean;
    status: string;
    errors: string[];
  };
  validatePullRequestContract(body: string, context?: {
    createdAt?: string;
    headSha?: string;
    baseSha?: string;
    baseRef?: string;
    relatedIssue?: { number: number; body: string; created_at: string; pull_request?: unknown };
  }): {
    ok: boolean;
    status: string;
    errors: string[];
  };
};

const SHA = 'a'.repeat(40);

const issueBody = `
\`\`\`yaml
AF_TASK_V1:
  priority: P1
  status: READY
  area: github-governance
  type: reliability
  execution: WEB
  base_mode: MAIN
  blocked_by: []
  conflicts_with: []
  paths:
    - scripts/example.cjs
    - tests/example.test.ts
  forbidden_paths:
    - src/**
  risk: MEDIUM
\`\`\`

## Problem
The problem.
## Why this matters
The impact.
## Scope
The scope.
## Acceptance criteria
- [ ] A criterion.
## Required tests
- [ ] A test.
## Non-goals
None.
## Safety / invariants
Read-only.
## Dependencies
None.
`;

const prBody = `
\`\`\`yaml
AF_PR_V1:
  issue: 73
  phase: IMPLEMENTING
  base_sha: ${SHA}
  base_mode: MAIN
  paths:
    - scripts/example.cjs
    - tests/example.test.ts
  blocked_by: []
  risk: MEDIUM
\`\`\`

Closes #73

## Summary
Summary.
`;

describe('autonomous contract validator', () => {
  it('accepts a complete AF_TASK_V1 Issue and its required sections', () => {
    const result = validator.validateIssueContract(issueBody, { createdAt: '2026-09-28T00:00:00Z' });
    expect(result).toMatchObject({ ok: true, status: 'VALID' });
    expect(result.errors).toEqual([]);
  });

  it('accepts inline YAML lists as well as the template block-list form', () => {
    const inline = issueBody
      .replace('  blocked_by: []', '  blocked_by: [85]')
      .replace('  conflicts_with: []', '  conflicts_with: [72, 73]')
      .replace('  paths:\n    - scripts/example.cjs\n    - tests/example.test.ts', '  paths: [scripts/example.cjs, tests/example.test.ts]')
      .replace('  forbidden_paths:\n    - src/**', '  forbidden_paths: [src/**]');
    const result = validator.validateIssueContract(inline, { createdAt: '2026-09-28T00:00:00Z' });
    expect(result).toMatchObject({ ok: true, status: 'VALID' });
  });

  it('allows an empty Issue path scope for an EXTERNAL operations contract', () => {
    const external = issueBody
      .replace('  status: READY', '  status: EXTERNAL')
      .replace('  execution: WEB', '  execution: EXTERNAL')
      .replace('  paths:\n    - scripts/example.cjs\n    - tests/example.test.ts', '  paths: []');
    const result = validator.validateIssueContract(external, { createdAt: '2026-09-28T00:00:00Z' });
    expect(result).toMatchObject({ ok: true, status: 'VALID' });
  });

  it('rejects malformed task enums, traversal paths, and missing required sections with field names', () => {
    const malformed = issueBody
      .replace('status: READY', 'status: MAYBE')
      .replace('    - scripts/example.cjs', '    - ../scripts/example.cjs')
      .replace('## Dependencies\nNone.\n', '');
    const result = validator.validateIssueContract(malformed, { createdAt: '2026-09-28T00:00:00Z' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('AF_TASK_V1.status'),
      expect.stringContaining('AF_TASK_V1.paths[0]'),
      expect.stringContaining("Issue section 'Dependencies'"),
    ]));
  });

  it('grandfathers pre-bootstrap Issues without a contract and rejects post-bootstrap omissions', () => {
    const historical = validator.validateIssueContract('Legacy issue body', { createdAt: '2026-09-26T05:10:03Z' });
    expect(historical).toMatchObject({ ok: true, status: 'GRANDFATHERED' });

    const current = validator.validateIssueContract('New issue body', { createdAt: validator.CONTRACT_EFFECTIVE_AT });
    expect(current.ok).toBe(false);
    expect(current.errors.join('\n')).toContain('AF_TASK_V1: fenced contract block is required');
  });

  it('accepts a PR contract when the closing Issue, base SHA, and target branch agree', () => {
    const result = validator.validatePullRequestContract(prBody, {
      createdAt: '2026-09-28T00:00:00Z',
      baseSha: SHA,
      baseRef: 'main',
      relatedIssue: { number: 73, body: issueBody, created_at: '2026-09-28T00:00:00Z' },
    });
    expect(result).toMatchObject({ ok: true, status: 'VALID' });
    expect(result.errors).toEqual([]);
  });

  it('accepts the equivalent un-fenced YAML form emitted by direct GitHub API body updates', () => {
    const bareBody = prBody.trim().replace(/^```yaml\n/, '').replace(/\n```\n/, '\n');
    const result = validator.validatePullRequestContract(bareBody, {
      createdAt: '2026-09-28T00:00:00Z',
      baseSha: SHA,
      baseRef: 'main',
      relatedIssue: { number: 73, body: issueBody, created_at: '2026-09-28T00:00:00Z' },
    });
    expect(result).toMatchObject({ ok: true, status: 'VALID' });
  });

  it('accepts and exact-head binds the optional manager review SHA', () => {
    const reviewedBody = prBody.replace(`  risk: MEDIUM\n`, `  risk: MEDIUM\n  reviewed_head_sha: ${SHA}\n`);
    const result = validator.validatePullRequestContract(reviewedBody, {
      createdAt: '2026-09-28T00:00:00Z',
      baseSha: SHA,
      baseRef: 'main',
      headSha: SHA,
      relatedIssue: { number: 73, body: issueBody, created_at: '2026-09-28T00:00:00Z' },
    });
    expect(result).toMatchObject({ ok: true, status: 'VALID' });
  });

  it('validates pull_request_target payloads through the read-only linked-Issue lookup', async () => {
    const result = await validator.validateEvent({
      pull_request: {
        body: prBody,
        created_at: '2026-09-28T00:00:00Z',
        base: { ref: 'main', sha: SHA },
        head: { sha: SHA },
      },
    }, {
      eventName: 'pull_request_target',
      repository: 'thanhtuyen662002/Agent-Forge',
      token: 'synthetic-token',
      fetchImpl: async (_url, _init) => ({
        ok: true,
        status: 200,
        async json() {
          return { number: 73, body: issueBody, created_at: '2026-09-28T00:00:00Z' };
        },
      }),
    });
    expect(result).toMatchObject({ ok: true, status: 'VALID' });
  });

  it('reports exact PR field failures for bad SHA, branch, closing reference, and linked Issue', () => {
    const malformed = prBody
      .replace(`base_sha: ${SHA}`, 'base_sha: not-a-sha')
      .replace('Closes #73', 'Closes #999');
    const result = validator.validatePullRequestContract(malformed, {
      createdAt: '2026-09-28T00:00:00Z',
      baseSha: SHA,
      baseRef: 'release',
      relatedIssue: { number: 73, body: issueBody, created_at: '2026-09-28T00:00:00Z' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('AF_PR_V1.base_sha'),
      expect.stringContaining('Closes #73'),
      expect.stringContaining("AF_PR_V1.base_mode: MAIN requires base branch 'main'"),
    ]));
  });

  it('grandfathers a pre-bootstrap PR without AF_PR_V1', () => {
    const result = validator.validatePullRequestContract('Legacy PR body', {
      createdAt: '2026-09-26T05:10:03Z',
      baseSha: SHA,
      baseRef: 'main',
    });
    expect(result).toMatchObject({ ok: true, status: 'GRANDFATHERED' });
  });

  it('parses supported closing keywords without accepting a mismatched issue reference', () => {
    expect(validator.closingIssueNumbers('Closes #73; fixes #74 and resolves #75')).toEqual([73, 74, 75]);
  });

  it('keeps the workflow trusted, read-only, and independent from the PR head', () => {
    const workflowPath = path.resolve(__dirname, '../.github/workflows/autonomy-contract-validation.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toMatch(/^  issues:\s*$/m);
    expect(workflow).toMatch(/^  pull_request_target:\s*$/m);
    expect(workflow).not.toMatch(/^  pull_request:\s*$/m);
    expect(workflow).toMatch(/contents:\s*read/);
    expect(workflow).toMatch(/issues:\s*read/);
    expect(workflow).toMatch(/pull-requests:\s*read/);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/issues:\s*write/);
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
    expect(workflow).toMatch(/ref: \$\{\{ github\.sha \}\}/);
    expect(workflow).not.toMatch(/pull_request\.head\.sha/);
    expect(workflow).toMatch(/node scripts\/autonomy-contract-validator\.cjs/);
    expect(workflow).not.toMatch(/npm(?:\.cmd)?\s+(?:test|run\s+(?:build|package))/);
  });
});
