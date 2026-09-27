import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub watchdog workflow contract', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/watchdog-health.yml');
  const scriptPath = path.resolve(__dirname, '../scripts/watchdog-health-report.cjs');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const script = fs.readFileSync(scriptPath, 'utf8');

  it('runs on a schedule and manual dispatch with read-only permissions', () => {
    expect(workflow).toMatch(/^  schedule:\s*$/m);
    expect(workflow).toMatch(/^  workflow_dispatch:\s*$/m);
    expect(workflow).toMatch(/contents:\s*read/);
    expect(workflow).toMatch(/issues:\s*read/);
    expect(workflow).toMatch(/pull-requests:\s*read/);
    expect(workflow).toMatch(/checks:\s*read/);
    expect(workflow).toMatch(/statuses:\s*read/);
    expect(workflow).toMatch(/actions:\s*read/);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/issues:\s*write/);
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
    expect(workflow).not.toMatch(/statuses:\s*write/);
    expect(workflow).not.toMatch(/checks:\s*write/);
  });

  it('pins third-party actions and executes only the deterministic watchdog script', () => {
    const actionLines = workflow.split(/\r?\n/).filter((line) => /\buses:\s*/.test(line));
    expect(actionLines.length).toBeGreaterThanOrEqual(3);
    for (const line of actionLines) expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+/i);
    expect(workflow).toContain('scripts/watchdog-health-report.cjs --collect');
    expect(workflow).toContain('--input "$RUNNER_TEMP/watchdog-snapshot.json"');
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(workflow).not.toMatch(/npm(?:\.cmd)?\s+(?:test|run\s+(?:build|package))/i);
    expect(workflow).not.toMatch(/\b(?:gh|git)\s+(?:issue|pr)\s+(?:close|merge|edit|comment|label)/i);
    expect(workflow).not.toMatch(/\.github\/workflows\/release-windows\.yml/);
    expect(script).toContain('A cancelled check is never counted as a failure');
    expect(script).toContain('supersededCancelled');
  });

  it('uploads only the generated report and never persists the raw GitHub snapshot as an artifact', () => {
    expect(workflow).toMatch(/path:\s*\$\{\{ runner\.temp \}\}\/watchdog-report\.md/);
    expect(workflow).not.toMatch(/path:\s*\$\{\{ runner\.temp \}\}\/watchdog-snapshot\.json/);
    expect(workflow).toMatch(/if-no-files-found:\s*ignore/);
    expect(workflow).toMatch(/retention-days:\s*7/);
  });
});
