import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/dev-channel.yml'), 'utf8');

/** #298: the dev channel publishes only verified main builds, as pre-releases. */
describe('dev-channel release workflow', () => {
  it('runs only after a successful push CI of main in this repository', () => {
    expect(workflow).toMatch(/workflow_run:\s*\n\s*workflows: \['AgentForge CI'\]\s*\n\s*types: \[completed\]\s*\n\s*branches: \[main\]/);
    expect(workflow).not.toMatch(/^\s*pull_request/m);
    for (const guard of ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'", 'github.event.workflow_run.head_repository.full_name == github.repository']) {
      expect(workflow).toContain(guard);
    }
  });

  it('grants write access only to the publishing job and builds the exact tested commit', () => {
    expect(workflow).toMatch(/^permissions:\s*\n\s*contents: read/m);
    expect(workflow).toMatch(/runs-on: windows-latest\s*\n\s*permissions:\s*\n\s*contents: write/);
    expect(workflow).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$TESTED_SHA"');
    expect(workflow).toContain('"$(git rev-parse origin/main)" = "$TESTED_SHA"');
  });

  it('stamps the version in CI only and publishes a pre-release, never the stable channel', () => {
    expect(workflow).toContain('DEV_VERSION: 0.1.${{ github.run_number }}');
    expect(workflow).toContain('npm version "$DEV_VERSION" --no-git-tag-version');
    expect(workflow).toContain('-c.publish.releaseType=prerelease');
    expect(workflow).not.toMatch(/git (commit|push)/);
    expect(workflow).toContain('--prerelease');
  });
});
