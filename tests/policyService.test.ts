import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PolicyService } from '../src/core/services/PolicyService';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';

describe('PolicyService', () => {
  const projectRoot = 'd:/Projects/Agent-Forge';

  function selectedFixture(): { fixture: string; root: string } {
    const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-policy-root-')));
    const root = path.join(fixture, 'repository'); fs.mkdirSync(root);
    return { fixture, root };
  }
  function cleanupFixture(fixture: string) {
    if (!path.basename(fixture).startsWith('af-policy-root-') || fs.realpathSync.native(fixture) !== fixture) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  it('classifies only the selected ordinary root while preserving outside and sensitive path rejection', () => {
    const { fixture, root } = selectedFixture();
    try {
      const identity = captureRepositoryRoot(root);
      expect(PolicyService.evaluateRepositoryPathAccess(path.join(root, 'src', 'new.ts'), identity).allowed).toBe(true);
      expect(PolicyService.evaluateRepositoryPathAccess(path.join(root, '.env.local'), identity).allowed).toBe(false);
      expect(PolicyService.evaluateRepositoryPathAccess(path.join(fixture, 'outside.ts'), identity).allowed).toBe(false);
    } finally { cleanupFixture(fixture); }
  });

  it('rejects root replacement instead of classifying the replacement as the selected authority', () => {
    const { fixture, root } = selectedFixture();
    try {
      const identity = captureRepositoryRoot(root);
      fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
      expect(PolicyService.evaluateRepositoryPathAccess(root, identity)).toMatchObject({
        allowed: false, decision: 'DENY', reasonCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED',
      });
    } finally { cleanupFixture(fixture); }
  });

  it('rejects a parent junction or symlink that appears after selection', () => {
    const { fixture, root } = selectedFixture();
    try {
      const identity = captureRepositoryRoot(root);
      fs.renameSync(root, root + '-original');
      fs.symlinkSync(root + '-original', root, process.platform === 'win32' ? 'junction' : 'dir');
      expect(PolicyService.evaluateRepositoryPathAccess(root, identity)).toMatchObject({
        allowed: false, decision: 'DENY', reasonCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED',
      });
      fs.unlinkSync(root);
    } finally { cleanupFixture(fixture); }
  });

  it('discards a real allowed classification if the selected root changes before return', () => {
    const { fixture, root } = selectedFixture();
    const realEvaluate = PolicyService.evaluateRealPathAccess.bind(PolicyService);
    try {
      const identity = captureRepositoryRoot(root);
      vi.spyOn(PolicyService, 'evaluateRealPathAccess').mockImplementationOnce((...args) => {
        const result = realEvaluate(...args); expect(result.allowed).toBe(true);
        fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
        return result;
      });
      expect(PolicyService.evaluateRepositoryPathAccess(root, identity)).toMatchObject({
        allowed: false, decision: 'DENY', reasonCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED',
      });
    } finally { vi.restoreAllMocks(); cleanupFixture(fixture); }
  });

  it('should allow file access within project root', () => {
    const res = PolicyService.evaluatePathAccess('d:/Projects/Agent-Forge/src/main.ts', projectRoot, true);
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe('ALLOW');
  });

  it('should prevent prefix-confusion attacks where target shares folder prefix with root', () => {
    const root = 'd:/temp/repo';
    const evilTarget = 'd:/temp/repo-evil/malicious.ts';

    const res = PolicyService.evaluatePathAccess(evilTarget, root, true);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('DENY');
    expect(res.reason).toContain('outside the authorized project root');
  });

  it('should allow legitimate nested files in project root', () => {
    const root = 'd:/temp/repo';
    const legitimateTarget = 'd:/temp/repo/src/components/Button.tsx';

    const res = PolicyService.evaluatePathAccess(legitimateTarget, root, true);
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe('ALLOW');
  });

  it('should deny path traversal attempts using .. syntax', () => {
    const root = 'd:/temp/repo';
    const traversalTarget = 'd:/temp/repo/../secret.env';

    const res = PolicyService.evaluatePathAccess(traversalTarget, root, true);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('DENY');
  });

  it('should deny write access outside project root', () => {
    const res = PolicyService.evaluatePathAccess('c:/Windows/System32/evil.dll', projectRoot, true);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('DENY');
  });

  it('should deny access to sensitive credential directories', () => {
    const res = PolicyService.evaluatePathAccess('c:/Users/Owner/.ssh/id_rsa', projectRoot, false);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('DENY');
    expect(res.reason).toContain('sensitive credential path');
  });

  it.each(['.env.local', '.env.production', '.npmrc', '.git/config', 'credentials.json', 'src/private.pem', 'src/api_key.txt'])
    ('should deny secret-bearing file variants: %s', (relativePath) => {
      const root = 'd:/Projects/Agent-Forge';
      const res = PolicyService.evaluatePathAccess(`${root}/${relativePath}`, root, false);
      expect(res.allowed).toBe(false);
      expect(res.decision).toBe('DENY');
    });

  it('should reject an existing symlink or junction that escapes the real repository root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-policy-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-policy-outside-'));
    const link = path.join(root, 'src');
    fs.mkdirSync(path.join(root, 'src-parent'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'payload.txt'), 'sensitive', 'utf8');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      const result = PolicyService.evaluateRealPathAccess(path.join(link, 'payload.txt'), root, false);
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('DENY');
      expect(result.reason).toContain('outside');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('should deny force pushing git branches and destructive git operations', () => {
    expect(PolicyService.evaluateGitCommand(['push', '--force', 'origin', 'feature']).allowed).toBe(false);
    expect(PolicyService.evaluateGitCommand(['push', '-f', 'origin', 'feature']).allowed).toBe(false);
    expect(PolicyService.evaluateGitCommand(['push', '--force-with-lease', 'origin', 'feature']).allowed).toBe(false);
    expect(PolicyService.evaluateGitCommand(['reset', '--hard', 'HEAD~1']).allowed).toBe(false);
    expect(PolicyService.evaluateGitCommand(['clean', '-fdx']).allowed).toBe(false);
  });

  it('should automatically invoke Git policy during structured process execution of git', () => {
    const res = PolicyService.evaluateProcessExecution('git', ['push', '-f', 'origin', 'main']);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('DENY');
    expect(res.reason).toContain('Force-pushing');
  });

  it('should require owner approval for package installation', () => {
    const res = PolicyService.evaluateProcessExecution('npm', ['install', 'axios']);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('REQUIRES_OWNER_APPROVAL');
  });

  it('should allow standard test commands', () => {
    const res = PolicyService.evaluateProcessExecution('npm', ['test']);
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe('ALLOW');
  });
});
