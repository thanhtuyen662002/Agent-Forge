import { describe, it, expect } from 'vitest';
import {
  CreateProjectIpcSchema,
  CreateTaskIpcSchema,
  TransitionProjectIpcSchema,
  UpdateResourceQuotaIpcSchema,
  ParseProtocolIpcSchema,
  EmergencyStopIpcSchema,
  ResumeProjectIpcSchema,
  RouteTaskIpcSchema,
  AuthorizeRoutedTaskIpcSchema,
  DispatchAuthorizationIpcSchema,
  GetOwnerHandoffSnapshotIpcSchema,
  GenerateAuthorizedWorkOrderIpcSchema,
  ListQuarantinedSubmissionsIpcSchema,
  InspectQuarantinedSubmissionIpcSchema,
  RejectQuarantinedSubmissionIpcSchema,
  SupersedeQuarantinedSubmissionIpcSchema,
  AdmitQuarantinedSubmissionIpcSchema,
  ResumeAdmittedSubmissionIpcSchema,
  AcknowledgeRecoveryFencedIpcSchema,
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

  it('should validate routing IPC schema and reject instructions or prompt overrides', () => {
    const validRoute = RouteTaskIpcSchema.safeParse({
      projectId: 'PROJ-1',
      taskId: 'TASK-1',
      candidateResourceIds: ['res-1', 'res-2'],
      allowManualBridge: true,
    });
    expect(validRoute.success).toBe(true);

    const invalidEmpty = RouteTaskIpcSchema.safeParse({
      projectId: '',
      taskId: '',
      candidateResourceIds: [],
    });
    expect(invalidEmpty.success).toBe(false);

    const invalidOverride = RouteTaskIpcSchema.safeParse({
      projectId: 'PROJ-1',
      taskId: 'TASK-1',
      candidateResourceIds: ['res-1'],
      instructions: ['caller prompt injection'], // forbidden
    });
    expect(invalidOverride.success).toBe(false);
  });

  it('should validate authorization IPC schema and reject caller-supplied instructions/prompts', () => {
    const validAuth = AuthorizeRoutedTaskIpcSchema.safeParse({
      projectId: 'PROJ-1',
      taskId: 'TASK-1',
      routingDecisionId: 'DEC-123',
      contextFiles: ['src/core/router.ts'],
    });
    expect(validAuth.success).toBe(true);

    const invalidInstructions = AuthorizeRoutedTaskIpcSchema.safeParse({
      projectId: 'PROJ-1',
      taskId: 'TASK-1',
      routingDecisionId: 'DEC-123',
      instructions: ['do something else'], // forbidden
    });
    expect(invalidInstructions.success).toBe(false);

    const invalidPrompt = AuthorizeRoutedTaskIpcSchema.safeParse({
      projectId: 'PROJ-1',
      taskId: 'TASK-1',
      routingDecisionId: 'DEC-123',
      prompt: 'do something else', // forbidden
    });
    expect(invalidPrompt.success).toBe(false);
  });

  it('should validate dispatch IPC schema and strictly accept authorizationId only', () => {
    const validDispatch = DispatchAuthorizationIpcSchema.safeParse({
      authorizationId: 'AUTH-123',
    });
    expect(validDispatch.success).toBe(true);

    const invalidEmpty = DispatchAuthorizationIpcSchema.safeParse({});
    expect(invalidEmpty.success).toBe(false);

    const invalidExtra = DispatchAuthorizationIpcSchema.safeParse({
      authorizationId: 'AUTH-123',
      requestOverride: { taskId: 'TASK-2' }, // forbidden
      decisionOverride: { selectedProviderId: 'prov-evil' }, // forbidden
    });
    expect(invalidExtra.success).toBe(false);
  });

  it('should validate handoff snapshot IPC schema', () => {
    expect(GetOwnerHandoffSnapshotIpcSchema.safeParse({ taskId: 'TASK-1' }).success).toBe(true);
    expect(GetOwnerHandoffSnapshotIpcSchema.safeParse({}).success).toBe(false);
    expect(GetOwnerHandoffSnapshotIpcSchema.safeParse({ taskId: '' }).success).toBe(false);
  });

  it('should validate generate authorized work order IPC schema and strictly accept authorizationId only', () => {
    expect(GenerateAuthorizedWorkOrderIpcSchema.safeParse({ authorizationId: 'AUTH-123' }).success).toBe(true);
    expect(GenerateAuthorizedWorkOrderIpcSchema.safeParse({}).success).toBe(false);
    expect(GenerateAuthorizedWorkOrderIpcSchema.safeParse({ authorizationId: '' }).success).toBe(false);
    expect(
      GenerateAuthorizedWorkOrderIpcSchema.safeParse({
        authorizationId: 'AUTH-123',
        instructions: ['override instructions'], // forbidden
      }).success
    ).toBe(false);
    expect(
      GenerateAuthorizedWorkOrderIpcSchema.safeParse({
        authorizationId: 'AUTH-123',
        prompt: 'override prompt', // forbidden
      }).success
    ).toBe(false);
  });

  it('should validate R5J5 quarantined submission adjudication IPC schemas strictly', () => {
    // List schema
    expect(ListQuarantinedSubmissionsIpcSchema.safeParse({}).success).toBe(true);
    expect(ListQuarantinedSubmissionsIpcSchema.safeParse({ limit: 10, offset: 0 }).success).toBe(true);
    expect(ListQuarantinedSubmissionsIpcSchema.safeParse({ limit: 101 }).success).toBe(false); // exceeds max 100
    expect(ListQuarantinedSubmissionsIpcSchema.safeParse({ limit: -1 }).success).toBe(false);
    expect(ListQuarantinedSubmissionsIpcSchema.safeParse({ extraKey: 'bad' }).success).toBe(false); // unknown key

    // Inspect schema
    expect(InspectQuarantinedSubmissionIpcSchema.safeParse({ submissionId: '00000000-0000-4000-8000-000000000001' }).success).toBe(true);
    expect(InspectQuarantinedSubmissionIpcSchema.safeParse({ submissionId: 'not-a-uuid' }).success).toBe(false);
    expect(InspectQuarantinedSubmissionIpcSchema.safeParse({ submissionId: '00000000-0000-4000-8000-000000000001', sql: 'DROP TABLE' }).success).toBe(false);

    // Reject schema
    expect(
      RejectQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000002',
        submissionId: '00000000-0000-4000-8000-000000000001',
        expectedLifecycleVersion: 0,
        reason: 'Operator rejected code',
      }).success
    ).toBe(true);
    expect(
      RejectQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000002',
        submissionId: '00000000-0000-4000-8000-000000000001',
        reason: 'Missing expectedLifecycleVersion',
      }).success
    ).toBe(false);
    expect(RejectQuarantinedSubmissionIpcSchema.safeParse({ requestId: 'not-uuid', submissionId: '00000000-0000-4000-8000-000000000001', expectedLifecycleVersion: 0, reason: 'reason' }).success).toBe(false);

    // Supersede schema
    expect(
      SupersedeQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000003',
        submissionId: '00000000-0000-4000-8000-000000000001',
        expectedLifecycleVersion: 1,
        replacementSubmissionId: '00000000-0000-4000-8000-000000000002',
        reason: 'Superseded by newer submission',
      }).success
    ).toBe(true);
    expect(
      SupersedeQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000003',
        submissionId: '00000000-0000-4000-8000-000000000001',
        expectedLifecycleVersion: 1,
        replacementSubmissionId: '00000000-0000-4000-8000-000000000002',
        reason: '', // empty reason fails
      }).success
    ).toBe(false);
    expect(
      SupersedeQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000003',
        submissionId: '00000000-0000-4000-8000-000000000001',
        replacementSubmissionId: '00000000-0000-4000-8000-000000000002',
        reason: 'Missing expectedLifecycleVersion',
      }).success
    ).toBe(false);

    // Admit schema
    expect(
      AdmitQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000004',
        submissionId: '00000000-0000-4000-8000-000000000001',
      }).success
    ).toBe(true);
    expect(
      AdmitQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000004',
        submissionId: '00000000-0000-4000-8000-000000000001',
        expectedLifecycleVersion: 0,
      }).success
    ).toBe(true);
    expect(
      AdmitQuarantinedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000004',
        submissionId: '00000000-0000-4000-8000-000000000001',
        commandOverride: 'npm test', // forbidden command injection
      }).success
    ).toBe(false);

    // Resume schema
    expect(
      ResumeAdmittedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000005',
        submissionId: '00000000-0000-4000-8000-000000000006',
        adjudicationId: '00000000-0000-4000-8000-000000000099',
        expectedLifecycleVersion: 1,
      }).success
    ).toBe(true);
    expect(
      ResumeAdmittedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000005',
        submissionId: '00000000-0000-4000-8000-000000000006',
        adjudicationId: '00000000-0000-4000-8000-000000000099',
        expectedLifecycleVersion: 0, // must be positive int
      }).success
    ).toBe(false);
    expect(
      ResumeAdmittedSubmissionIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000005',
        submissionId: '00000000-0000-4000-8000-000000000006',
        expectedLifecycleVersion: 1,
      }).success
    ).toBe(false); // missing adjudicationId

    // Acknowledge recovery fenced schema
    expect(
      AcknowledgeRecoveryFencedIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000007',
        submissionId: '00000000-0000-4000-8000-000000000008',
        adjudicationId: '00000000-0000-4000-8000-000000000099',
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      }).success
    ).toBe(true);
    expect(
      AcknowledgeRecoveryFencedIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000007',
        submissionId: '00000000-0000-4000-8000-000000000008',
        adjudicationId: '00000000-0000-4000-8000-000000000099',
        expectedLifecycleVersion: 2,
        decision: 'ACKNOWLEDGE',
      }).success
    ).toBe(true);
    expect(
      AcknowledgeRecoveryFencedIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000007',
        submissionId: '00000000-0000-4000-8000-000000000008',
        adjudicationId: '00000000-0000-4000-8000-000000000099',
        expectedLifecycleVersion: 2,
        decision: 'RETRY', // forbidden in corrective pass 1
      }).success
    ).toBe(false);
    expect(
      AcknowledgeRecoveryFencedIpcSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000007',
        submissionId: '00000000-0000-4000-8000-000000000008',
        adjudicationId: '00000000-0000-4000-8000-000000000099',
        expectedLifecycleVersion: 2,
        decision: 'RERUN', // not in enum ['ACKNOWLEDGE', 'CANCEL']
      }).success
    ).toBe(false);
  });
});
