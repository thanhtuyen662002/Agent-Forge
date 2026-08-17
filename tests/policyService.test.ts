import { describe, it, expect } from 'vitest';
import { PolicyService } from '../src/core/services/PolicyService';

describe('PolicyService', () => {
  const projectRoot = 'd:/Projects/Agent-Forge';

  it('should allow file access within project root', () => {
    const res = PolicyService.evaluatePathAccess('d:/Projects/Agent-Forge/src/main.ts', projectRoot, true);
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe('ALLOW');
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

  it('should deny force pushing git branches', () => {
    const res = PolicyService.evaluateGitCommand(['push', '--force', 'origin', 'feature']);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('DENY');
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
