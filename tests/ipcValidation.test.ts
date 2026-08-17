import { describe, it, expect } from 'vitest';
import {
  CreateProjectIpcSchema,
  CreateTaskIpcSchema,
  ImportContractIpcSchema,
  UpdateResourceQuotaIpcSchema,
  RunVerificationIpcSchema,
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

  it('should reject arbitrary shell executable execution via PolicyService', () => {
    const shellRes = PolicyService.evaluateProcessExecution('cmd.exe', ['/c', 'dir'], true);
    expect(shellRes.allowed).toBe(false);
    expect(shellRes.decision).toBe('REQUIRES_OWNER_APPROVAL');

    const bashRes = PolicyService.evaluateProcessExecution('bash', ['-c', 'ls'], false);
    expect(bashRes.allowed).toBe(false);
    expect(bashRes.decision).toBe('REQUIRES_OWNER_APPROVAL');
  });

  it('should reject writing to paths outside project boundary', () => {
    const res = PolicyService.evaluatePathAccess('c:/system32/cmd.exe', 'd:/Projects/Agent-Forge', true);
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe('DENY');
  });
});
