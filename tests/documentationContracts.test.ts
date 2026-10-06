import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Documentation runtime-state and update-policy contracts', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const read = (relativePath: string): string => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

  const readme = read('README.md');
  const architecture = read('docs/ARCHITECTURE.md');
  const demoRunbook = read('docs/DEMO-RELEASE-CANDIDATE.md');

  it('distinguishes the Manual Bridge result from the durable task state', () => {
    const handoffDocs = `${readme}\n${architecture}\n${demoRunbook}`;

    expect(handoffDocs).toContain('AWAITING_OWNER');
    expect(handoffDocs).toContain('HANDOFF_REQUIRED');
    expect(handoffDocs).toMatch(/Manual Bridge[\s\S]{0,180}AWAITING_OWNER/);
    expect(handoffDocs).toMatch(/durable task state remains[\s\S]{0,100}(CODING|HANDOFF_REQUIRED)/i);
    expect(handoffDocs).not.toMatch(/task (?:enters|moves to|becomes)\s+`?AWAITING_OWNER`?/i);
    expect(architecture).toMatch(/not a value in `TaskStateEnum`/);
  });

  it('states the implemented update controls without promising unattended or signed production updates', () => {
    expect(readme).toContain('check/download lifecycle');
    expect(readme).toContain('autoDownload=false');
    expect(readme).toContain('autoInstallOnAppQuit=false');
    expect(readme).toContain('--publish never');
    expect(readme).toContain('manual release workflow is the only publisher');
    expect(readme).toContain('does not establish signed production publication');
    expect(readme).not.toMatch(/Auto-Update.*Intentionally deferred/i);

    expect(architecture).toContain('not a claim of signed production publication or unattended updating');
    expect(architecture).toContain('Installed-App Integration Test Scope');
    expect(architecture).toContain('does not publish a release, sign an installer');

    expect(demoRunbook).toContain('local generic feed');
    expect(demoRunbook).toContain('does not represent a published or signed production release');
    expect(demoRunbook).toContain('FULL_UPDATE_INSTALL_RESTART_TEST=MANUAL_FINAL_GATE_REQUIRED');
  });
});
