import { RepositoryRootLease } from '../core/services/RepositoryRootLease';
import type { Evidence } from '../core/types/domain';
import { OutputSanitizationError, redactSensitiveText, sanitizeOutputValue } from '../shared/security/secretRedaction';
import { sanitizeErrorDiagnostics, sanitizedDiagnosticError } from '../shared/security/outputDiagnostics';
import { ipcMain, dialog, app } from 'electron';
import { Repository } from '../core/database/repositories';
import { ProjectService } from '../core/services/ProjectService';
import { TaskService } from '../core/services/TaskService';
import { GitService } from '../core/services/GitService';
import { VerificationService } from '../core/services/VerificationService';
import { VerificationCapabilityService } from '../core/services/VerificationCapabilityService';
import { VerificationCapabilityError, VerificationCapabilityPayload, VerificationCapabilityReference } from '../core/types/verificationCapability';
import { ProtocolParser } from '../core/protocol/parser';
import { PackageGenerator } from '../core/protocol/packageGenerator';
import { defaultArtifactStore } from '../core/services/ArtifactStore';
import { EmergencyStopService } from '../core/services/EmergencyStopService';
import { PolicyService } from '../core/services/PolicyService';
import { RepositorySelectionService } from '../core/services/RepositorySelectionService';
import { assertRepositoryRootIdentity, captureRepositoryRoot, RepositoryRootError } from '../core/services/RepositoryRootIdentity';
import { ProviderRoutingService } from '../core/services/ProviderRoutingService';
import { ExecutionAuthorizationService } from '../core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../core/services/ProviderDispatchService';
import { UpdateService } from '../core/services/UpdateService';
import { CommandParser } from '../core/services/CommandParser';
import {
  CreateProjectIpcSchema,
  BindProjectRepositoryIpcSchema,
  ImportContractIpcSchema,
  TransitionProjectIpcSchema,
  CreateTaskIpcSchema,
  ParseProtocolIpcSchema,
  ApplyProtocolIpcSchema,
  GenerateWorkOrderIpcSchema,
  GenerateReviewPackageIpcSchema,
  UpdateResourceQuotaIpcSchema,
  ProjectScopedIpcSchema,
  TaskScopedIpcSchema,
  StartReviewIpcSchema,
  RunVerificationIpcSchema,
  EmergencyStopIpcSchema,
  ResumeProjectIpcSchema,
  RouteTaskIpcSchema,
  AuthorizeRoutedTaskIpcSchema,
  DispatchAuthorizationIpcSchema,
  GetOwnerHandoffSnapshotIpcSchema,
  GenerateAuthorizedWorkOrderIpcSchema,
  UpdateGetStateIpcSchema,
  UpdateCheckIpcSchema,
  UpdateDownloadIpcSchema,
  UpdateInstallAndRestartIpcSchema,
  GetAppInfoIpcSchema,
  GetVerificationCommandsIpcSchema,
  SaveVerificationCommandsIpcSchema,
  GetMaxRevisionsIpcSchema,
  SaveMaxRevisionsIpcSchema,
  ListQuarantinedSubmissionsIpcSchema,
  InspectQuarantinedSubmissionIpcSchema,
  AdmitQuarantinedSubmissionIpcSchema,
  RejectQuarantinedSubmissionIpcSchema,
  SupersedeQuarantinedSubmissionIpcSchema,
  ResumeAdmittedSubmissionIpcSchema,
  AcknowledgeRecoveryFencedIpcSchema,
} from '../core/types/ipc';
import {
  CoderSubmissionAdjudicationService,
  scrubAdjudicationDiagnostics,
} from '../core/services/CoderSubmissionAdjudicationService';
import { CoderSubmissionAdjudicationError } from '../core/types/adjudication';
import {
  isTrustedIpcSender,
  RendererNavigationPolicyOptions,
  resolveRendererNavigationPolicy,
} from './pathHelper';

export class IpcSenderTrustError extends Error {
  readonly code = 'IPC_SENDER_UNTRUSTED' as const;

  constructor() {
    super('IPC_SENDER_UNTRUSTED: privileged IPC requires a trusted renderer frame.');
    this.name = 'IpcSenderTrustError';
  }
}

type PrivilegedIpcHandler = (event: unknown, payload: unknown) => unknown | Promise<unknown>;

function safeEvidenceOutput(evidence: Evidence): Evidence {
  const safe = sanitizeOutputValue(evidence) as Evidence;
  // Only descriptive summary can change. Bytes and the metadata identifying
  // their stored hash/path must remain exact, including legacy inline bytes.
  for (const key of Object.keys(evidence) as Array<keyof Evidence>) {
    if (key !== 'summary' && safe[key] !== evidence[key]) throw new OutputSanitizationError('OUTPUT_REDACTION_UNSAFE');
  }
  return safe;
}

function safeEvidenceText(text: unknown): string {
  const safe = redactSensitiveText(text);
  if (safe !== text) throw new OutputSanitizationError('OUTPUT_REDACTION_UNSAFE');
  return safe;
}

export function scrubAdjudicationError(err: unknown): { code: string; message: string } {
  if (err instanceof CoderSubmissionAdjudicationError) {
    return { code: err.code, message: scrubAdjudicationDiagnostics(err.message) };
  }
  const msg = sanitizeErrorDiagnostics(err).message;
  if (msg.includes('NOT_FOUND')) return { code: 'NOT_FOUND', message: 'Requested resource not found.' };
  if (msg.includes('INTEGRITY') || msg.includes('CHECKSUM') || msg.includes('HASH')) return { code: 'INTEGRITY_CONFLICT', message: 'Durable integrity conflict detected.' };
  if (msg.includes('PRECONDITION') || msg.includes('FENCED')) return { code: 'PRECONDITION_FENCED', message: 'Precondition check failed or authority fenced.' };
  if (msg.includes('STATUS') || msg.includes('STATE')) return { code: 'STATUS_CONFLICT', message: 'Incompatible status transition.' };
  if (msg.includes('REQUEST_ID') || msg.includes('IDEMPOTENCY')) return { code: 'REQUEST_ID_CONFLICT', message: 'Request ID collision or conflict.' };
  if (msg.includes('WORKTREE') || msg.includes('DRIFT')) return { code: 'WORKTREE_DRIFT', message: 'Working tree or Git repository drift.' };
  if (msg.includes('COMMAND') || msg.includes('SNAPSHOT')) return { code: 'COMMAND_SNAPSHOT_INVALID', message: 'Verification command snapshot is invalid.' };
  if (msg.includes('IN_FLIGHT') || msg.includes('CLAIMED')) return { code: 'VERIFICATION_IN_FLIGHT', message: 'Verification is currently in-flight.' };
  if (msg.includes('RECOVERY_FENCED')) return { code: 'RECOVERY_FENCED', message: 'Execution is recovery-fenced.' };
  return { code: 'INTERNAL_ERROR', message: 'An internal error occurred during adjudication.' };
}

export function registerIpcHandlers(
  repo: Repository,
  projectService: ProjectService,
  taskService: TaskService,
  verificationService: VerificationService,
  emergencyStopService: EmergencyStopService,
  providerRoutingService?: ProviderRoutingService,
  executionAuthorizationService?: ExecutionAuthorizationService,
  providerDispatchService?: ProviderDispatchService,
  updateService?: UpdateService,
  coderSubmissionAdjudicationService?: CoderSubmissionAdjudicationService,
  rendererPolicy: RendererNavigationPolicyOptions = resolveRendererNavigationPolicy({ isPackaged: false }),
): void {
  const adjService =
    coderSubmissionAdjudicationService ||
    new CoderSubmissionAdjudicationService(repo, repo.getDatabase(), verificationService);

  const registerPrivilegedHandler = (channel: string, handler: PrivilegedIpcHandler): void => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedIpcSender(event, rendererPolicy)) {
        throw new IpcSenderTrustError();
      }
      try { return await handler(event, payload); }
      catch (error) {
        if (error instanceof RepositoryRootError) return { success: false, errorCode: error.code, error: error.message };
        if (error instanceof OutputSanitizationError) throw new OutputSanitizationError(error.code);
        throw sanitizedDiagnosticError(error);
      }
    });
  };
  const capabilityApprovalsInProgress = new Set<string>();
  // ==========================================
  // Trusted Repository Selection Dialog
  // ==========================================
  registerPrivilegedHandler('dialog:selectRepository', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (canceled || filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    try {
      const rootIdentity = captureRepositoryRoot(filePaths[0]);
      const selectedPath = rootIdentity.canonicalPath;

      // Validate path against security policy
      const policy = PolicyService.evaluateRepositoryPathAccess(selectedPath, rootIdentity, false);
      if (!policy.allowed) {
        return {
          success: false,
          errorCode: policy.reasonCode ?? 'INVALID_REPOSITORY_LOCATION',
          errorDetail: policy.reason,
          error: `Invalid repository location: ${policy.reason}`,
        };
      }

      // Verify directory is a genuine Git working tree
      const gitStatus = await GitService.getStatus(selectedPath, rootIdentity);
      if (gitStatus.status !== 'SUCCESS') {
        const errorDetail = gitStatus.errorMessage || 'git status failed';
        return {
          success: false,
          errorCode: gitStatus.errorCode ?? 'NOT_GIT_REPOSITORY',
          errorDetail,
          error: `Selected directory is not a valid Git repository (${errorDetail}).`,
        };
      }

      // Issue short-lived, single-use selection token
      const token = RepositorySelectionService.issueToken(filePaths[0], rootIdentity);

      return {
        success: true,
        selectionId: token.selectionId,
        displayPath: token.displayPath,
      };
    } catch (error) {
      if (!(error instanceof RepositoryRootError)) throw error;
      return { success: false, errorCode: error.code, errorDetail: error.message, error: error.message };
    }
  });

  // ==========================================
  // Projects
  // ==========================================
  registerPrivilegedHandler('project:create', async (_, payload: unknown) => {
    const parsed = CreateProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    // Consume native selection token
    const tokenRes = RepositorySelectionService.consumeToken(parsed.data.repositorySelectionId);
    if (!tokenRes.success || !tokenRes.canonicalPath || !tokenRes.rootIdentity) {
      return { success: false, errorCode: tokenRes.errorCode, error: tokenRes.error || 'Invalid repository selection token.' };
    }

    try {
      const canonicalRepoPath = tokenRes.canonicalPath;

      // Validate path security and Git repository validity
      const policy = PolicyService.evaluateRepositoryPathAccess(canonicalRepoPath, tokenRes.rootIdentity, false);
      if (!policy.allowed) {
        return { success: false, errorCode: policy.reasonCode ?? 'INVALID_REPOSITORY_LOCATION', error: policy.reason };
      }

      const gitStatus = await GitService.getStatus(canonicalRepoPath, tokenRes.rootIdentity);
      if (gitStatus.status !== 'SUCCESS') {
        return {
          success: false,
          errorCode: gitStatus.errorCode,
          error: `Repository path is not a valid Git repository: ${gitStatus.errorMessage || 'git status failed'}`,
        };
      }

      assertRepositoryRootIdentity(tokenRes.rootIdentity);
      const project = projectService.createProject(
        parsed.data.name,
        parsed.data.description,
        canonicalRepoPath,
        parsed.data.defaultBranch,
        tokenRes.rootIdentity,
      );

      return { success: true, project };
    } catch (error) {
      if (!(error instanceof RepositoryRootError)) throw error;
      return { success: false, errorCode: error.code, error: error.message };
    }
  });

  registerPrivilegedHandler('project:bindRepository', async (_, payload: unknown) => {
    const parsed = BindProjectRepositoryIpcSchema.safeParse(payload);
    if (!parsed.success) return { success: false, error: 'A project ID and native repository selection are required.' };
    const selected = RepositorySelectionService.consumeToken(parsed.data.repositorySelectionId);
    if (!selected.success || !selected.canonicalPath || !selected.rootIdentity) {
      return { success: false, errorCode: selected.errorCode, error: selected.error || 'Invalid repository selection token.' };
    }
    try {
      const metadata = repo.getProjectMetadata(parsed.data.projectId);
      if (!metadata || metadata.repository_path !== selected.canonicalPath) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
      const policy = PolicyService.evaluateRepositoryPathAccess(selected.canonicalPath, selected.rootIdentity, false);
      if (!policy.allowed) return { success: false, errorCode: policy.reasonCode ?? 'INVALID_REPOSITORY_LOCATION', error: policy.reason };
      const status = await GitService.getStatus(selected.canonicalPath, selected.rootIdentity);
      if (status.status !== 'SUCCESS') return { success: false, errorCode: status.errorCode ?? 'NOT_GIT_REPOSITORY', error: 'The configured repository could not be verified.' };
      assertRepositoryRootIdentity(selected.rootIdentity);
      return { success: true, project: projectService.bindRepository(parsed.data.projectId, selected.rootIdentity) };
    } catch (error) {
      if (!(error instanceof RepositoryRootError)) throw error;
      return { success: false, errorCode: error.code, error: error.message };
    }
  });

  registerPrivilegedHandler('project:get', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return null;
    return repo.getProjectMetadata(parsed.data.projectId);
  });

  registerPrivilegedHandler('project:list', async () => {
    return repo.getAllProjects();
  });

  registerPrivilegedHandler('project:importContract', async (_, payload: unknown) => {
    const parsed = ImportContractIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return projectService.importContract(parsed.data.projectId, parsed.data.contract as any);
  });

  registerPrivilegedHandler('project:transition', async (_, payload: unknown) => {
    const parsed = TransitionProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return projectService.transitionStatus(parsed.data.projectId, parsed.data.trigger);
  });

  // ==========================================
  // Tasks
  // ==========================================
  registerPrivilegedHandler('task:create', async (_, payload: unknown) => {
    const parsed = CreateTaskIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const task = taskService.createTask(parsed.data);
      return { success: true, task };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  registerPrivilegedHandler('task:get', async (_, payload: unknown) => {
    const parsed = TaskScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return null;
    return repo.getTask(parsed.data.taskId);
  });

  registerPrivilegedHandler('task:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return repo.getTasksByProject(parsed.data.projectId);
  });

  registerPrivilegedHandler('task:startReview', async (_, payload: unknown) => {
    const parsed = StartReviewIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return taskService.startReview(parsed.data.taskId, parsed.data.expectedProjectId, {
      expectedRevision: parsed.data.expectedRevision,
      expectedOwnershipEpoch: parsed.data.expectedOwnershipEpoch,
      expectedState: parsed.data.expectedState,
      executionId: parsed.data.executionId,
    });
  });

  // ==========================================
  // Protocols & Package Generation
  // ==========================================
  registerPrivilegedHandler('protocol:parse', async (_, payload: unknown) => {
    const parsed = ParseProtocolIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return ProtocolParser.parse(parsed.data.rawInput);
  });

  registerPrivilegedHandler('protocol:apply', async (_, payload: unknown) => {
    const parsed = ApplyProtocolIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const parseRes = ProtocolParser.parse(parsed.data.rawInput);
    if (!parseRes.success || !parseRes.data) {
      return { success: false, error: `Invalid protocol format: ${parseRes.error}` };
    }

    if (parseRes.data.type === 'manager.v1') {
      return await taskService.applyManagerDecision(parseRes.data.data, parsed.data.rawInput);
    } else if (parseRes.data.type === 'coder.v1') {
      return taskService.applyCoderReport(parseRes.data.data, parsed.data.rawInput);
    }

    return { success: false, error: 'Unrecognized protocol payload type.' };
  });

  registerPrivilegedHandler('protocol:generateWorkOrder', async (_, payload: unknown) => {
    const parsed = GenerateWorkOrderIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const project = repo.getProject(parsed.data.projectId);
    const task = repo.getTask(parsed.data.taskId);
    if (!project || !task) {
      return { success: false, error: 'Project or Task not found.' };
    }

    // Cross-project guard
    if (task.project_id !== project.id) {
      return {
        success: false,
        error: `Cross-project guard: Task "${task.id}" belongs to project "${task.project_id}", not "${project.id}".`,
      };
    }

    const workOrder = PackageGenerator.generateWorkOrder(project, task, repo);
    return { success: true, workOrder };
  });

  registerPrivilegedHandler('protocol:generateReviewPackage', async (_, payload: unknown) => {
    const parsed = GenerateReviewPackageIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const project = repo.getProject(parsed.data.projectId);
    let task = repo.getTask(parsed.data.taskId);
    if (!project || !task) {
      return { success: false, error: 'Project or Task not found.' };
    }

    // Cross-project guard
    if (task.project_id !== project.id) {
      return {
        success: false,
        error: `Cross-project guard: Task "${task.id}" belongs to project "${task.project_id}", not "${project.id}".`,
      };
    }

    // Authoritative evidence loaded from SQLite
    const latestTestRun = repo.getLatestTestRun(task.id);
    const gitDiffEv = repo.getLatestEvidence(task.id, 'GIT_DIFF');
    const reviews = repo.getReviewsByTask(task.id);

    let diffContent = '';
    let diffStat = '';

    if (gitDiffEv) {
      const safeDiff = safeEvidenceOutput(gitDiffEv);
      diffStat = safeDiff.summary || 'Git Diff recorded.';
      try {
        diffContent = defaultArtifactStore.read(gitDiffEv);
      } catch {
        diffContent = gitDiffEv.raw_payload || '';
      }
      diffContent = safeEvidenceText(diffContent);
    } else {
      // Strict fail-closed CLEAN-NOOP fallback
      // Condition 1: Task state is REVIEW_READY or REVIEWING
      if (task.state !== 'REVIEW_READY' && task.state !== 'REVIEWING') {
        return {
          success: false,
          error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Task is not in REVIEW_READY or REVIEWING state for clean no-op validation.',
        };
      }

      // Condition 2 & 3: A latest authoritative TestRun exists with exit_code === 0
      if (!latestTestRun) {
        return {
          success: false,
          error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: No authoritative TestRun found for clean no-op validation.',
        };
      }
      if (latestTestRun.exit_code !== 0) {
        return {
          success: false,
          error: `AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Latest TestRun has non-zero exit code (${latestTestRun.exit_code}) for clean no-op validation.`,
        };
      }

      // Condition 4, 5, 6: task.base_sha and task.current_sha are non-null, non-empty, and equal
      if (!task.base_sha || !task.base_sha.trim() || !task.current_sha || !task.current_sha.trim()) {
        return {
          success: false,
          error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Missing base_sha or current_sha on task for clean no-op validation.',
        };
      }
      if (task.base_sha !== task.current_sha) {
        return {
          success: false,
          error: `AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Base SHA (${task.base_sha}) differs from current SHA (${task.current_sha}) for clean no-op validation.`,
        };
      }

      // Condition 7: Durable latest GIT_STATUS evidence exists for this task
      const gitStatusEv = repo.getLatestEvidence(task.id, 'GIT_STATUS');
      if (!gitStatusEv) {
        return {
          success: false,
          error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: No durable GIT_STATUS evidence found for clean no-op validation.',
        };
      }

      // Condition 8: Read the actual durable GIT_STATUS evidence using ArtifactStore with raw_payload fallback
      safeEvidenceOutput(gitStatusEv);
      let rawStatusPayload = '';
      try {
        rawStatusPayload = defaultArtifactStore.read(gitStatusEv);
      } catch {
        rawStatusPayload = gitStatusEv.raw_payload || '';
      }
      rawStatusPayload = safeEvidenceText(rawStatusPayload);

      // Condition 9: The GIT_STATUS payload parses as JSON successfully
      let parsedGitStatus: any = null;
      try {
        parsedGitStatus = JSON.parse(rawStatusPayload);
      } catch {
        return {
          success: false,
          error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Durable GIT_STATUS evidence is not valid JSON for clean no-op validation.',
        };
      }

      // Condition 10 & 11: Parsed Git status reports status === "SUCCESS" and isClean === true
      if (!parsedGitStatus || parsedGitStatus.status !== 'SUCCESS') {
        return {
          success: false,
          error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Durable GIT_STATUS evidence status is not SUCCESS for clean no-op validation.',
        };
      }
      if (parsedGitStatus.isClean !== true) {
        return {
          success: false,
          error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: Durable GIT_STATUS evidence reports working tree is not clean for clean no-op validation.',
        };
      }

      // All 11 conditions hold: set clean no-op inputs
      diffContent = '';
      diffStat = 'Git Diff: 0 files changed (validated clean no-op working tree)';
    }

    // Atomically advance task to REVIEWING if in REVIEW_READY
    if (task.state === 'REVIEW_READY') {
      const reviewStartRes = taskService.startReview(task.id, project.id);
      if (reviewStartRes.success && reviewStartRes.task) {
        task = reviewStartRes.task;
      }
    }

    // Restore latest applied coder report from protocol ledger
    const taskMessages = repo.getProtocolMessagesByTask(task.id);
    const coderMsgRecord = taskMessages
      .filter((m) => m.protocol === 'coder.v1' && m.status === 'APPLIED')
      .pop();

    let coderReport = null;
    if (coderMsgRecord && coderMsgRecord.raw_payload) {
      const parsedCoder = ProtocolParser.parse(String(coderMsgRecord.raw_payload));
      if (parsedCoder.success && parsedCoder.data?.type === 'coder.v1') {
        coderReport = parsedCoder.data.data;
      }
    }

    // Exact adjudication linkage for R5J5 (never substitute unrelated protocol message)
    let adjudicationLinkage = null;
    const taskAdjudications = repo.getCoderSubmissionAdjudicationsByTask(task.id);
    const activeOrLatestAdj =
      taskAdjudications.find((a) => a.status === 'VERIFIED' || a.status === 'ADMITTED' || a.status === 'VERIFYING') ||
      taskAdjudications[0];

    if (activeOrLatestAdj) {
      const submission = repo.getCoderSubmissionById(activeOrLatestAdj.submission_id);
      if (!submission) {
        throw new Error(
          `ADJUDICATION_SUBMISSION_NOT_FOUND: Submission "${activeOrLatestAdj.submission_id}" bound to adjudication "${activeOrLatestAdj.id}" not found.`
        );
      }
      try {
        const projection = adjService.buildVerifiedAdjudicationReviewProjection(activeOrLatestAdj.id);
        const reviewPackage = PackageGenerator.renderVerifiedAdjudicationReviewProjection(projection);
        return { success: true, reviewPackage: redactSensitiveText(reviewPackage) };
      } catch (error) {
        if (error instanceof OutputSanitizationError) throw error;
        const adjTestRun = activeOrLatestAdj.test_run_id ? repo.getTestRun(activeOrLatestAdj.test_run_id) : null;
        const gitStatusEv = activeOrLatestAdj.git_status_evidence_id
          ? repo.getEvidence(activeOrLatestAdj.git_status_evidence_id)
          : null;
        const gitDiffEvFromAdj = activeOrLatestAdj.git_diff_evidence_id
          ? repo.getEvidence(activeOrLatestAdj.git_diff_evidence_id)
          : null;

        adjudicationLinkage = {
          adjudication: activeOrLatestAdj,
          submission,
          testRun: adjTestRun,
          gitStatusEvidence: gitStatusEv,
          gitDiffEvidence: gitDiffEvFromAdj || gitDiffEv,
        };
      }
    }

    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      task,
      coderReport,
      diffStat,
      diffContent,
      latestTestRun,
      reviews,
      gitDiffEv || undefined,
      adjudicationLinkage
    );

    return { success: true, reviewPackage: redactSensitiveText(reviewPackage) };
  });

  // ==========================================
  // Git & Verification (Derives path securely from SQLite)
  // ==========================================
  registerPrivilegedHandler('git:getStatus', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        status: 'ERROR',
        branch: 'UNKNOWN',
        isClean: false,
        modifiedFiles: [],
        untrackedFiles: [],
        aheadCount: 0,
        behindCount: 0,
        errorMessage: 'Invalid project ID',
      };
    }

    try {
      const project = repo.getProject(parsed.data.projectId);
      if (!project) {
        return {
          status: 'ERROR',
          branch: 'UNKNOWN',
          isClean: false,
          modifiedFiles: [],
          untrackedFiles: [],
          aheadCount: 0,
          behindCount: 0,
          errorMessage: 'Project not found',
        };
      }

      const rootIdentity = repo.getProjectRepositoryIdentity(project.id);
      return await GitService.getStatus(project.repository_path, rootIdentity);
    } catch (error) {
      if (!(error instanceof RepositoryRootError)) throw error;
      return { status: 'ERROR', branch: 'UNKNOWN', isClean: false, modifiedFiles: [], untrackedFiles: [],
        aheadCount: 0, behindCount: 0, errorCode: error.code, errorMessage: error.message };
    }
  });

  registerPrivilegedHandler('git:getDiff', async (_, payload: unknown) => {
    const parsed = TaskScopedIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorMessage: 'Invalid task ID',
      };
    }

    const task = repo.getTask(parsed.data.taskId);
    if (!task) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorMessage: 'Task not found',
      };
    }

    try {
      const project = repo.getProject(task.project_id);
      if (!project) {
        return {
          status: 'ERROR',
          diffStat: '',
          diffContent: '',
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          errorMessage: 'Project not found',
        };
      }

      const rootIdentity = repo.getProjectRepositoryIdentity(project.id);
      return await GitService.getDiff(project.repository_path, task.base_sha, rootIdentity);
    } catch (error) {
      if (!(error instanceof RepositoryRootError)) throw error;
      return { status: 'ERROR', diffStat: '', diffContent: '', filesChanged: [], insertions: 0, deletions: 0,
        errorCode: error.code, errorMessage: error.message };
    }
  });

  registerPrivilegedHandler('verification:runTests', async (_, payload: unknown) => {
    const parsed = RunVerificationIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    return taskService.executeValidationFlow(
      parsed.data.taskId,
      parsed.data.commandConfigId,
      parsed.data.expectedProjectId,
      {
        expectedRevision: parsed.data.expectedRevision,
        expectedOwnershipEpoch: parsed.data.expectedOwnershipEpoch,
        expectedState: parsed.data.expectedState,
        executionId: parsed.data.executionId,
      },
    );
  });

  registerPrivilegedHandler('verification:getCommands', async (_, payload: unknown) => {
    const parsed = GetVerificationCommandsIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const project = repo.getProject(parsed.data.projectId);
    if (!project) {
      return { success: false, error: `Project "${parsed.data.projectId}" not found.` };
    }

    const commands = repo.getVerificationCommandsByProject(project.id);
    return { success: true, commands };
  });

  registerPrivilegedHandler('verification:saveCommands', async (_, payload: unknown) => {
    const parsed = SaveVerificationCommandsIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const project = repo.getProjectForRepositoryUse(parsed.data.projectId);
    if (!project) {
      return { success: false, error: `Project "${parsed.data.projectId}" not found.` };
    }

    if (capabilityApprovalsInProgress.has(project.id)) {
      return { success: false, error: 'CAPABILITY_APPROVAL_IN_PROGRESS' };
    }
    const rootLease = RepositoryRootLease.acquire(repo.getProjectRepositoryIdentity(project.id));
    capabilityApprovalsInProgress.add(project.id);
    const capabilities = new VerificationCapabilityService(repo);
    const approved: VerificationCapabilityReference[] = [];
    const before = JSON.stringify(repo.getVerificationCommandsByProject(project.id));
    const parsedCommands: Partial<Record<'TEST' | 'LINT' | 'BUILD', {
      executable: string; args: string[]; capability: VerificationCapabilityReference;
    } | null>> = {};
    const proposals: Partial<Record<'TEST' | 'LINT' | 'BUILD', VerificationCapabilityPayload>> = {};
    const types: Array<'TEST' | 'LINT' | 'BUILD'> = ['TEST', 'LINT', 'BUILD'];
    try {
      for (const type of types) {
        if (!(type in parsed.data.commands)) continue;
        const rawCmd = parsed.data.commands[type];
        const command = rawCmd?.trim() ? CommandParser.parse(rawCmd) : null;
        if (command) {
          proposals[type] = capabilities.propose(project.id, command.executable, command.args, project.repository_path);
        } else {
          parsedCommands[type] = null;
        }
      }
      // Only a native backend dialog can grant approval. Renderer fields never
      // authorize a command, even when the sender frame is trusted.
      const decision = await dialog.showMessageBox({
        type: 'warning', title: 'Approve verification capabilities',
        message: `Save verification commands for ${project.name}?`,
        detail: `These commands run with your OS permissions. Approval binds the displayed executable, files and exact arguments.\n\n${JSON.stringify({
          project_root: project.repository_path,
          commands: Object.fromEntries(types.filter((type) => type in parsed.data.commands).map((type) => [type, proposals[type] ?? null])),
        }, null, 2)}`,
        buttons: ['Approve', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (decision.response !== 0) throw new VerificationCapabilityError('OWNER_APPROVAL_REQUIRED');
      for (const type of types) {
        const proposal = proposals[type];
        if (!proposal) continue;
        const capability = await capabilities.approve(proposal, async () => true);
        approved.push(capability);
        parsedCommands[type] = { executable: proposal.executable.path, args: [...proposal.args], capability };
      }
      const updatedCommands = repo.runInImmediateTransaction(() => {
        const current = repo.getProjectForRepositoryUse(project.id);
        if (!current || current.repository_path !== project.repository_path ||
            JSON.stringify(repo.getVerificationCommandsByProject(project.id)) !== before) {
          throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
        }
        const commands = repo.setProjectVerificationCommands(project.id, parsedCommands);
        rootLease.assertActive();
        return commands;
      });
      return { success: true, commands: updatedCommands };
    } catch (error) {
      for (const reference of approved) {
        try { capabilities.revoke(reference); } catch { /* A replaced/revoked grant is already fenced. */ }
      }
      if (error instanceof RepositoryRootError) return { success: false, errorCode: error.code, error: error.message };
      return { success: false, error: error instanceof VerificationCapabilityError ? error.code : 'INVALID_VERIFICATION_CAPABILITY' };
    } finally {
      rootLease.close();
      capabilityApprovalsInProgress.delete(project.id);
    }
  });

  registerPrivilegedHandler('settings:getMaxRevisions', async (_, payload: unknown) => {
    const parsed = GetMaxRevisionsIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const project = repo.getProject(parsed.data.projectId);
    if (!project) {
      return { success: false, error: `Project "${parsed.data.projectId}" not found.` };
    }

    return { success: true, maxRevisions: repo.getProjectMaxRevisions(project.id) };
  });

  registerPrivilegedHandler('settings:saveMaxRevisions', async (_, payload: unknown) => {
    const parsed = SaveMaxRevisionsIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const project = repo.getProject(parsed.data.projectId);
    if (!project) {
      return { success: false, error: `Project "${parsed.data.projectId}" not found.` };
    }

    try {
      const maxRevisions = repo.setProjectMaxRevisions(project.id, parsed.data.maxRevisions);
      return { success: true, maxRevisions };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to save max revisions.' };
    }
  });

  // ==========================================
  // Providers & Agents
  // ==========================================
  registerPrivilegedHandler('providers:listResources', async () => {
    return repo.getAllProviderResources();
  });

  registerPrivilegedHandler('agents:list', async () => {
    return repo.getAllAgents();
  });

  registerPrivilegedHandler('providers:updateResourceQuota', async (_, payload: unknown) => {
    const parsed = UpdateResourceQuotaIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const updated = repo.runInImmediateTransaction(() => {
      if (!repo.getProviderResource(parsed.data.id)) return false;
      repo.updateProviderResourceQuota(
        parsed.data.id,
        parsed.data.remaining,
        parsed.data.total,
        parsed.data.source,
        parsed.data.confidence
      );
      return true;
    });
    if (!updated) return { success: false, error: 'RESOURCE_NOT_FOUND' };
    return { success: true };
  });

  // ==========================================
  // Events & Evidence Queries
  // ==========================================
  registerPrivilegedHandler('events:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return sanitizeOutputValue(repo.getEventsByProject(parsed.data.projectId));
  });

  registerPrivilegedHandler('evidence:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    const evidence = repo.getEvidenceByProject(parsed.data.projectId);
    // Validate cumulative structure/text bounds before returning any row.
    sanitizeOutputValue(evidence);
    return evidence.map(safeEvidenceOutput);
  });

  // ==========================================
  // Emergency Controls
  // ==========================================
  registerPrivilegedHandler('control:emergencyStop', async (_, payload: unknown) => {
    const parsed = EmergencyStopIpcSchema.safeParse(payload || {});
    const reason = parsed.success ? parsed.data.reason : 'Manual Owner Emergency Stop';
    return emergencyStopService.triggerEmergencyStop(reason);
  });

  registerPrivilegedHandler('control:resume', async (_, payload: unknown) => {
    const parsed = ResumeProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    return emergencyStopService.resumeProject(parsed.data.projectId);
  });

  // ==========================================
  // PR #8: Owner Routing & Manual Bridge Handoff
  // ==========================================

  registerPrivilegedHandler('routing:routeTask', async (_, payload: unknown) => {
    if (!providerRoutingService) {
      return { success: false, error: 'ProviderRoutingService unavailable.' };
    }
    const parsed = RouteTaskIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const uniqueCandidates = new Set(parsed.data.candidateResourceIds);
    if (uniqueCandidates.size !== parsed.data.candidateResourceIds.length) {
      return {
        success: false,
        error: 'DUPLICATE_CANDIDATE_RESOURCES: Duplicate candidate resource IDs are not permitted.',
      };
    }

    try {
      const decision = await providerRoutingService.route({
        projectId: parsed.data.projectId,
        taskId: parsed.data.taskId,
        attemptId: parsed.data.attemptId,
        candidateResourceIds: parsed.data.candidateResourceIds,
        allowManualBridge: parsed.data.allowManualBridge,
        requiredCapabilities: ['CODING'],
      });
      return { success: true, decision };
    } catch (err: any) {
      return { success: false, error: err.message || 'Routing failed.' };
    }
  });

  registerPrivilegedHandler('routing:authorizeTask', async (_, payload: unknown) => {
    if (!executionAuthorizationService) {
      return { success: false, error: 'ExecutionAuthorizationService unavailable.' };
    }
    const parsed = AuthorizeRoutedTaskIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    try {
      const authorization = await executionAuthorizationService.createAuthorization(parsed.data);
      return { success: true, authorization };
    } catch (err: any) {
      return { success: false, error: err.message || 'Authorization creation failed.' };
    }
  });

  registerPrivilegedHandler('routing:dispatchAuthorization', async (_, payload: unknown) => {
    if (!providerDispatchService) {
      return { success: false, error: 'ProviderDispatchService unavailable.' };
    }
    const parsed = DispatchAuthorizationIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    try {
      const result =
        parsed.data.executionMode === 'MANUAL_BRIDGE'
          ? await providerDispatchService.dispatchManualBridge(parsed.data.authorizationId)
          : await providerDispatchService.dispatchProductBound(parsed.data.authorizationId);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: err.message || 'Dispatch failed.' };
    }
  });

  registerPrivilegedHandler('routing:getHandoffSnapshot', async (_, payload: unknown) => {
    const parsed = GetOwnerHandoffSnapshotIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const task = repo.getTask(parsed.data.taskId);
    if (!task) {
      return { success: false, error: `Task "${parsed.data.taskId}" not found.` };
    }

    const project = repo.getProjectMetadata(task.project_id);
    const latestManagerRecord = repo.getLatestAppliedManagerProtocolMessage(task.id, task.project_id);

    let hasAuthority = false;
    let decisionValidForCurrentRevision = false;
    let authorityReason: string | undefined;
    let instructionsCount = 0;
    let parsedDecision: string | null = null;
    let parsedExpectedRevision: number | null = null;

    if (latestManagerRecord && latestManagerRecord.raw_payload) {
      const parsedProto = ProtocolParser.parse(String(latestManagerRecord.raw_payload));
      if (parsedProto.success && parsedProto.data?.type === 'manager.v1') {
        const mData = parsedProto.data.data;
        instructionsCount = Array.isArray(mData.instructions) ? mData.instructions.length : 0;
        parsedDecision = mData.decision ?? null;
        parsedExpectedRevision = typeof mData.expected_revision === 'number' ? mData.expected_revision : null;

        if (mData.decision === 'EXECUTE') {
          hasAuthority = true;
          decisionValidForCurrentRevision = parsedExpectedRevision === task.revision_count;
          if (!decisionValidForCurrentRevision) {
            authorityReason = `Manager EXECUTE expected revision (${parsedExpectedRevision}) does not match task revision (${task.revision_count}).`;
          }
        } else if (mData.decision === 'FIX_REQUIRED') {
          hasAuthority = true;
          decisionValidForCurrentRevision =
            parsedExpectedRevision !== null && parsedExpectedRevision + 1 === task.revision_count;
          if (!decisionValidForCurrentRevision) {
            authorityReason = `Manager FIX_REQUIRED expected revision (${
              parsedExpectedRevision !== null ? parsedExpectedRevision + 1 : 'null'
            }) does not match task revision (${task.revision_count}).`;
          }
        } else {
          authorityReason = `Latest Manager decision is non-authorizing: ${mData.decision}.`;
        }
      }
    } else {
      authorityReason = 'No applied manager.v1 protocol message found for this task.';
    }

    let gitHeadSha: string | null = null;
    if (project) {
      try {
        const identity = repo.getProjectRepositoryIdentity(project.id);
        const headRes = await GitService.getHeadSha(project.repository_path, identity);
        if (headRes.status === 'SUCCESS' && headRes.sha) {
          gitHeadSha = headRes.sha;
        } else if (headRes.errorCode) {
          decisionValidForCurrentRevision = false;
          authorityReason = headRes.errorCode;
        }
      } catch (error) {
        if (!(error instanceof RepositoryRootError)) throw error;
        decisionValidForCurrentRevision = false;
        authorityReason = error.code;
      }
    }

    const providerResources = repo.getAllProviderResources();
    const authorizations = repo.getExecutionAuthorizationsByTask(task.id);
    const latestAuthorization = authorizations.length > 0 ? authorizations[0] : null;

    // Retrieve latest routing decision event for this task directly from SQLite (candidate for a NEW authorization)
    let latestRoutingDecision: any = null;
    if (project) {
      const routingEvent = repo.getLatestRoutingDecisionEventByTask(project.id, task.id);
      if (routingEvent && routingEvent.structured_payload) {
        latestRoutingDecision = routingEvent.structured_payload;
      }
    }

    // Retrieve EXACT routing decision referenced by latestAuthorization.routing_decision_id
    let authorizationRoutingDecision: any = null;
    if (latestAuthorization && latestAuthorization.routing_decision_id) {
      const authRoutingEvent = repo.getRoutingDecisionEvent(latestAuthorization.routing_decision_id);
      if (authRoutingEvent && authRoutingEvent.structured_payload) {
        authorizationRoutingDecision = authRoutingEvent.structured_payload;
      }
    }

    return {
      success: true,
      snapshot: {
        task,
        project,
        managerAuthority: {
          hasAuthority,
          messageId: latestManagerRecord?.id ? String(latestManagerRecord.id) : null,
          decision: parsedDecision,
          payloadHash: latestManagerRecord?.payload_hash ? String(latestManagerRecord.payload_hash) : null,
          expectedRevision: parsedExpectedRevision,
          instructionsCount,
          createdAt: latestManagerRecord?.created_at ? String(latestManagerRecord.created_at) : null,
          decisionValidForCurrentRevision,
          reason: authorityReason,
        },
        gitHeadSha,
        providerResources,
        latestRoutingDecision,
        authorizationRoutingDecision,
        latestAuthorization,
      },
    };
  });

  registerPrivilegedHandler('routing:generateAuthorizedWorkOrder', async (_, payload: unknown) => {
    const parsed = GenerateAuthorizedWorkOrderIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    try {
      const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(parsed.data.authorizationId, repo);
      return { success: true, workOrder };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to generate authorized manual WorkOrder.' };
    }
  });

  // ==========================================
  // PR #9: App Info & Update Lifecycle Handlers
  // ==========================================

  registerPrivilegedHandler('app:getInfo', async (_, payload: unknown) => {
    const parsed = GetAppInfoIpcSchema.safeParse(payload || {});
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return {
      success: true,
      info: {
        version: typeof app?.getVersion === 'function' ? app.getVersion() : '0.1.0',
        isPackaged: typeof app?.isPackaged === 'boolean' ? app.isPackaged : false,
        platform: process.platform,
        arch: process.arch,
      },
    };
  });

  registerPrivilegedHandler('update:getState', async (_, payload: unknown) => {
    const parsed = UpdateGetStateIpcSchema.safeParse(payload || {});
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    if (!updateService) {
      return {
        success: true,
        summary: {
          state: 'DISABLED',
          currentVersion: typeof app?.getVersion === 'function' ? app.getVersion() : '0.1.0',
          updateInfo: null,
          progress: null,
          error: null,
          isPackaged: typeof app?.isPackaged === 'boolean' ? app.isPackaged : false,
          isCodeSigned: false,
          canInstall: false,
          lastCheckedAt: null,
        },
      };
    }
    return { success: true, summary: updateService.getState() };
  });

  registerPrivilegedHandler('update:check', async (_, payload: unknown) => {
    const parsed = UpdateCheckIpcSchema.safeParse(payload || {});
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    if (!updateService) {
      return { success: false, error: 'Update service not available.' };
    }
    try {
      const summary = await updateService.checkForUpdates();
      return { success: true, summary };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to check for updates.' };
    }
  });

  registerPrivilegedHandler('update:download', async (_, payload: unknown) => {
    const parsed = UpdateDownloadIpcSchema.safeParse(payload || {});
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    if (!updateService) {
      return { success: false, error: 'Update service not available.' };
    }
    try {
      const summary = await updateService.downloadUpdate();
      return { success: true, summary };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to download update.' };
    }
  });

  registerPrivilegedHandler('update:installAndRestart', async (_, payload: unknown) => {
    const parsed = UpdateInstallAndRestartIpcSchema.safeParse(payload || {});
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    if (!updateService) {
      return { success: false, error: 'Update service not available.' };
    }
    try {
      updateService.installAndRestart();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to install update.' };
    }
  });

  // ==========================================
  // R5J5: Quarantined Submission Adjudication
  // ==========================================
  registerPrivilegedHandler('submissions:list', async (_, payload: unknown) => {
    const parsed = ListQuarantinedSubmissionsIpcSchema.safeParse(payload || {});
    if (!parsed.success) {
      return { success: false, error: 'INVALID_ARGUMENTS', message: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const result = adjService.listQuarantinedSubmissions(parsed.data);
      return { success: true, ...result };
    } catch (err: unknown) {
      const scrubbed = scrubAdjudicationError(err);
      return { success: false, error: scrubbed.code, message: scrubbed.message };
    }
  });

  registerPrivilegedHandler('submissions:inspect', async (_, payload: unknown) => {
    const parsed = InspectQuarantinedSubmissionIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: 'INVALID_ARGUMENTS', message: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const detail = adjService.inspectQuarantinedSubmission(parsed.data.submissionId);
      return { success: true, detail };
    } catch (err: unknown) {
      const scrubbed = scrubAdjudicationError(err);
      return { success: false, error: scrubbed.code, message: scrubbed.message };
    }
  });

  registerPrivilegedHandler('submissions:admit', async (_, payload: unknown) => {
    const parsed = AdmitQuarantinedSubmissionIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: 'INVALID_ARGUMENTS', message: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const result = await adjService.admitSubmissionForVerification(parsed.data);
      return { success: true, result };
    } catch (err: unknown) {
      const scrubbed = scrubAdjudicationError(err);
      return { success: false, error: scrubbed.code, message: scrubbed.message };
    }
  });

  registerPrivilegedHandler('submissions:reject', async (_, payload: unknown) => {
    const parsed = RejectQuarantinedSubmissionIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: 'INVALID_ARGUMENTS', message: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const result = adjService.rejectSubmission(parsed.data);
      return { success: true, result };
    } catch (err: unknown) {
      const scrubbed = scrubAdjudicationError(err);
      return { success: false, error: scrubbed.code, message: scrubbed.message };
    }
  });

  registerPrivilegedHandler('submissions:supersede', async (_, payload: unknown) => {
    const parsed = SupersedeQuarantinedSubmissionIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: 'INVALID_ARGUMENTS', message: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const result = adjService.supersedeSubmission(parsed.data);
      return { success: true, result };
    } catch (err: unknown) {
      const scrubbed = scrubAdjudicationError(err);
      return { success: false, error: scrubbed.code, message: scrubbed.message };
    }
  });

  registerPrivilegedHandler('submissions:resume', async (_, payload: unknown) => {
    const parsed = ResumeAdmittedSubmissionIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: 'INVALID_ARGUMENTS', message: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const result = await adjService.resumeAdmittedSubmission(parsed.data);
      return { success: true, result };
    } catch (err: unknown) {
      const scrubbed = scrubAdjudicationError(err);
      return { success: false, error: scrubbed.code, message: scrubbed.message };
    }
  });

  registerPrivilegedHandler('submissions:acknowledgeFenced', async (_, payload: unknown) => {
    const parsed = AcknowledgeRecoveryFencedIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: 'INVALID_ARGUMENTS', message: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const result = adjService.acknowledgeRecoveryFenced(parsed.data);
      return { success: true, result };
    } catch (err: unknown) {
      const scrubbed = scrubAdjudicationError(err);
      return { success: false, error: scrubbed.code, message: scrubbed.message };
    }
  });
}
