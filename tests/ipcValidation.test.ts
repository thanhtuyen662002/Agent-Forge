import { describe, it, expect } from 'vitest';
import {
  CreateProjectIpcSchema,
  CreateTaskIpcSchema,
  TransitionProjectIpcSchema,
  UpdateResourceQuotaIpcSchema,
  ParseProtocolIpcSchema,
  EmergencyStopIpcSchema,
  ResumeProjectIpcSchema,
} from '../src/core/types/ipc';
import { PolicyService } from '../src/core/services/PolicyService';

describe('IPC Validation & Security Gates', () => {
  it('should validate project creation payloads and reject raw repository paths', () => {
    const invalidEmpty = CreateProjectIpcSchema.safeParse({});
    expect(invalidEmpty.success).toBe(false);

    // Raw repository path without valid UUID selection token is rejected
    const invalidRaw = CreateProjectIpcSchema.safeParse({
      name: 'Test Project',
      repositoryPath: 'd:/Projects/Agent-Forge',
    });
    expect(invalidRaw.success).toBe(false);

    const validWithToken = CreateProjectIpcSchema.safeParse({
      name: 'Valid Proj',
      repositorySelectionId: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(validWithToken.success).toBe(true);
  });

  it('should validate task creation payloads and reject internal domain field overrides', () => {
    const invalidPriority = CreateTaskIpcSchema.safeParse({
      projectId: 'PROJ-1',
      title: 'Title',
      priority: 'SUPER_CRITICAL', // invalid enum
    });
    expect(invalidPriority.success).toBe(false);

    const validOwnerSpec = CreateTaskIpcSchema.safeParse({
      projectId: 'PROJ-1',
      title: 'Valid Task Title',
      description: 'Owner description',
      priority: 'HIGH',
      risk: 'MEDIUM',
      acceptanceCriteria: ['Must pass tests'],
      constraints: [],
    });
    expect(validOwnerSpec.success).toBe(true);
  });

  it('should validate protocol parse payloads', () => {
    expect(ParseProtocolIpcSchema.safeParse({}).success).toBe(false);
    expect(ParseProtocolIpcSchema.safeParse({ rawInput: '' }).success).toBe(false);
    expect(ParseProtocolIpcSchema.safeParse({ rawInput: '{"protocol":"manager.v1"}' }).success).toBe(true);
  });

  it('should validate transition project payloads and reject untyped/invalid triggers', () => {
    const invalidTrigger = TransitionProjectIpcSchema.safeParse({
      projectId: 'PROJ-1',
      trigger: 'INVALID_RANDOM_TRIGGER',
    });
    expect(invalidTrigger.success).toBe(false);

    const validTrigger = TransitionProjectIpcSchema.safeParse({
      projectId: 'PROJ-1',
      trigger: 'START_PROJECT',
    });
    expect(validTrigger.success).toBe(true);
  });

  it('should validate emergency stop with deliberate fail-safe defaults and validate resume payloads', () => {
    // Empty object safely defaults reason
    const emptyStop = EmergencyStopIpcSchema.safeParse({});
    expect(emptyStop.success).toBe(true);
    if (emptyStop.success) {
      expect(emptyStop.data.reason).toBe('Manual Owner Emergency Stop');
    }

    const explicitStop = EmergencyStopIpcSchema.safeParse({ reason: 'Security incident' });
    expect(explicitStop.success).toBe(true);

    expect(ResumeProjectIpcSchema.safeParse({}).success).toBe(false);
    expect(ResumeProjectIpcSchema.safeParse({ projectId: 'PROJ-1' }).success).toBe(true);
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
