import { describe, it, expect } from 'vitest';
import { PolicyService } from '../src/core/services/PolicyService';

describe('PolicyService', () => {
  const projectRoot = 'd:/Projects/Agent-Forge';

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
