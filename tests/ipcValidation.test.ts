import { describe, it, expect } from 'vitest';
import {
  CreateProjectIpcSchema,
  CreateTaskIpcSchema,
  UpdateResourceQuotaIpcSchema,
} from '../src/core/types/ipc';
import { PolicyService } from '../src/core/services/PolicyService';

describe('IPC Validation & Security Gates', () => {
  it('should reject invalid project creation payloads', () => {
    const invalidEmpty = CreateProjectIpcSchema.safeParse({});
    expect(invalidEmpty.success).toBe(false);

    const invalidName = CreateProjectIpcSchema.safeParse({ name: '', repositoryPath: 'd:/test' });
    expect(invalidName.success).toBe(false);

    const valid = CreateProjectIpcSchema.safeParse({ name: 'Valid Proj', repositoryPath: 'd:/test' });
    expect(valid.success).toBe(true);
  });

  it('should reject invalid task creation payloads', () => {
    const invalidPriority = CreateTaskIpcSchema.safeParse({
      id: 'TSK-1',
      project_id: 'PROJ-1',
      title: 'Title',
      priority: 'SUPER_CRITICAL', // invalid enum
    });
    expect(invalidPriority.success).toBe(false);
  });

  it('should reject invalid quota updates with confidence out of bounds', () => {
    const invalidConf = UpdateResourceQuotaIpcSchema.safeParse({
      id: 'res-1',
      remaining: 10,
      total: 100,
      source: 'MANUAL',
      confidence: 1.5, // > 1.0
    });
    expect(invalidConf.success).toBe(false);
  });

  it('should reject inline code-evaluation flags across runtimes without owner approval', () => {
    const nodeEval = PolicyService.evaluateProcessExecution('node', ['-e', 'console.log("bad");']);
    expect(nodeEval.allowed).toBe(false);
    expect(nodeEval.decision).toBe('REQUIRES_OWNER_APPROVAL');

    const nodePrint = PolicyService.evaluateProcessExecution('node.exe', ['-p', 'process.env']);
    expect(nodePrint.allowed).toBe(false);
    expect(nodePrint.decision).toBe('REQUIRES_OWNER_APPROVAL');

    const pyEval = PolicyService.evaluateProcessExecution('python3', ['-c', 'import os; os.system("ls")']);
    expect(pyEval.allowed).toBe(false);
    expect(pyEval.decision).toBe('REQUIRES_OWNER_APPROVAL');

    const phpEval = PolicyService.evaluateProcessExecution('php', ['-r', 'phpinfo();']);
    expect(phpEval.allowed).toBe(false);
    expect(phpEval.decision).toBe('REQUIRES_OWNER_APPROVAL');
  });

  it('should reject raw shell execution and download tools without owner approval', () => {
    const shellRes = PolicyService.evaluateProcessExecution('cmd.exe', ['/c', 'dir'], true);
    expect(shellRes.allowed).toBe(false);
    expect(shellRes.decision).toBe('REQUIRES_OWNER_APPROVAL');

    const bashRes = PolicyService.evaluateProcessExecution('bash', ['-c', 'ls'], false);
    expect(bashRes.allowed).toBe(false);
    expect(bashRes.decision).toBe('REQUIRES_OWNER_APPROVAL');

    const curlRes = PolicyService.evaluateProcessExecution('curl', ['https://example.com']);
    expect(curlRes.allowed).toBe(false);
    expect(curlRes.decision).toBe('REQUIRES_OWNER_APPROVAL');
  });

  it('should reject access to sensitive directory structures and paths outside project root', () => {
    const outsideRes = PolicyService.evaluatePathAccess('c:/windows/system32', 'd:/Projects/Agent-Forge', true);
    expect(outsideRes.allowed).toBe(false);
    expect(outsideRes.decision).toBe('DENY');

    const sshRes = PolicyService.evaluatePathAccess('d:/Projects/Agent-Forge/.ssh/id_rsa', 'd:/Projects/Agent-Forge', true);
    expect(sshRes.allowed).toBe(false);
    expect(sshRes.decision).toBe('DENY');
  });
});
