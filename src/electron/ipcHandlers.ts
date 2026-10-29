import { RepositoryRootLease } from '../core/services/RepositoryRootLease';
import type { Evidence } from '../core/types/domain';
import { OutputSanitizationError, redactSensitiveText, sanitizeOutputValue } from '../shared/security/secretRedaction';
import { sanitizeErrorDiagnostics, sanitizedDiagnosticError } from '../shared/security/outputDiagnostics';
import { ipcMain, dialog, app, shell } from 'electron';
import { Repository } from '../core/database/repositories';
import { ProjectService } from '../core/services/ProjectService';
import { TaskService } from '../core/services/TaskService';
import { GitService } from '../core/services/GitService';
import { VerificationService } from '../core/services/VerificationService';
import { VerificationCapabilityService } from '../core/services/VerificationCapabilityService';
import { VerificationCapabilityError, VerificationCapabilityPayload, VerificationCapabilityReference } from '../core/types/verificationCapability';
import { ProtocolParser } from '../core/protocol/parser';
import { validateContextPaths } from '../core/protocol/planProtocol';
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
import { WorkspaceManagementService } from '../core/services/WorkspaceManagementService';
import type { DesktopAutomationService } from '../core/services/DesktopAutomationService';
import type { AccountQuotaService } from '../core/services/AccountQuotaService';
import type { CodexAccountConnectionService } from '../core/services/CodexAccountConnectionService';
import type { CliAccountConnectionService } from '../core/services/CliAccountConnectionService';
import { ModelCatalogService } from '../core/services/ModelCatalogService';
import { AgentConnectionKindEnum } from '../core/types/workspace';
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
  TaskContextPathsIpcSchema,
  SetTaskContextPathsIpcSchema,
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

/**
 * The event handed to handlers for a call from the local MCP server (#289).
 * A renderer never produces it; the MCP server authenticated the caller with
 * the owner's token before invoking.
 */
const MCP_CALLER_EVENT = Object.freeze({ agentForgeMcpCaller: true });
const isMcpCaller = (event: unknown): boolean => event === MCP_CALLER_EVENT;

/** Channels an authenticated MCP caller may invoke; never credentials, sign-in, release or MCP settings. */
export const MCP_INVOKABLE_CHANNELS: ReadonlySet<string> = new Set([
  'project:list', 'project:get', 'project:create', 'project:importContract', 'project:transition',
  'task:list', 'task:get', 'task:create', 'task:retry', 'events:list', 'agents:roster',
  'verification:getCommands', 'verification:saveCommands',
  'automation:status', 'automation:managerDecisions', 'automation:setManagerMode', 'automation:decideManagerProposal',
  'automation:getParallelTasks', 'automation:setParallelTasks',
  'integration:list', 'integration:getAuto', 'integration:setAuto', 'integration:merge',
  'control:resume',
]);

export interface IpcHandlerRegistry {
  /** Runs a registered handler for the authenticated local MCP server, with the same fences as the renderer. */
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  /** The native repository dialog's checks for a path the MCP caller names; returns a single-use selection. */
  selectRepositoryPath(repositoryPath: string): Promise<unknown>;
}

/** Owner controls for the local MCP server, served to the renderer only (#289). */
export interface McpSettingsControl {
  getSettings(): unknown;
  setEnabled(enabled: boolean): Promise<unknown>;
  regenerateToken(): Promise<unknown>;
}

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
  runtime: {
    automation?: DesktopAutomationService; quota?: AccountQuotaService; signIn?: CodexAccountConnectionService; cliSignIn?: CliAccountConnectionService;
    models?: ModelCatalogService; mcp?: McpSettingsControl;
  } = {},
): IpcHandlerRegistry {
  const adjService =
    coderSubmissionAdjudicationService ||
    new CoderSubmissionAdjudicationService(repo, repo.getDatabase(), verificationService);

  const workspaceManagementService = new WorkspaceManagementService(repo);

  // Owner trash fence. Mutations and work-order generation for a trashed
  // project or task are refused before the handler runs; trashing also
  // invalidated its AUTHORIZED executions and dispatch re-checks the trash.
  const trashFencedChannels = new Set([
    'project:importContract', 'project:transition', 'task:create', 'task:retry', 'task:startReview', 'task:setContextPaths',
    'protocol:generateWorkOrder', 'protocol:generateReviewPackage', 'verification:runTests',
    'verification:saveCommands', 'routing:routeTask', 'routing:authorizeTask',
    'routing:dispatchAuthorization', 'routing:generateAuthorizedWorkOrder',
  ]);
  const trashRejection = (projectId: unknown, taskId: unknown) => {
    const trashed = (typeof projectId === 'string' && repo.isProjectTrashed(projectId)) ||
      (typeof taskId === 'string' && repo.isTaskTrashed(taskId));
    return trashed
      ? { success: false, errorCode: 'ENTITY_IN_TRASH', error: 'ENTITY_IN_TRASH: Restore the project or task from the trash first.' }
      : null;
  };
  const trashFence = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;
    let taskId = record.taskId;
    if (typeof record.authorizationId === 'string') {
      taskId = repo.getExecutionAuthorization(record.authorizationId)?.task_id ?? taskId;
    }
    return trashRejection(record.projectId ?? record.expectedProjectId, taskId);
  };

  const fencedHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const registerPrivilegedHandler = (channel: string, handler: PrivilegedIpcHandler): void => {
    const run = async (event: unknown, payload: unknown): Promise<unknown> => {
      if (trashFencedChannels.has(channel)) {
        const rejected = trashFence(payload);
        if (rejected) return rejected;
      }
      try { return await handler(event, payload); }
      catch (error) {
        if (error instanceof RepositoryRootError) return { success: false, errorCode: error.code, error: error.message };
        if (error instanceof OutputSanitizationError) throw new OutputSanitizationError(error.code);
        throw sanitizedDiagnosticError(error);
      }
    };
    fencedHandlers.set(channel, run);
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedIpcSender(event, rendererPolicy)) {
        throw new IpcSenderTrustError();
      }
      return run(event, payload);
    });
  };
  const capabilityApprovalsInProgress = new Set<string>();
  // ==========================================
  // Trusted Repository Selection Dialog
  // ==========================================
  // The same checks for a directory the owner picked or the MCP caller named (#289).
  const selectRepository = async (chosenPath: string) => {
    try {
      const rootIdentity = captureRepositoryRoot(chosenPath);
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
      const token = RepositorySelectionService.issueToken(chosenPath, rootIdentity);

      return {
        success: true,
        selectionId: token.selectionId,
        displayPath: token.displayPath,
      };
    } catch (error) {
      if (!(error instanceof RepositoryRootError)) throw error;
      return { success: false, errorCode: error.code, errorDetail: error.message, error: error.message };
    }
  };
  registerPrivilegedHandler('dialog:selectRepository', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (canceled || filePaths.length === 0) {
      return { success: false, cancelled: true };
    }
    return selectRepository(filePaths[0]);
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
    return repo.getAllProjects().filter((project) => !repo.isProjectTrashed(project.id));
  });

  registerPrivilegedHandler('project:importContract', async (_, payload: unknown) => {
    const parsed = ImportContractIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    // Typed acknowledgement: the renderer only treats an explicit success envelope as saved.
    if (!projectService.importContract(parsed.data.projectId, parsed.data.contract as any)) {
      return { success: false, errorCode: 'PROJECT_NOT_FOUND', error: `Project "${parsed.data.projectId}" not found.` };
    }
    return { success: true, project: repo.getProjectMetadata(parsed.data.projectId) };
  });

  registerPrivilegedHandler('project:transition', async (_, payload: unknown) => {
    const parsed = TransitionProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    try {
      const status = projectService.transitionStatus(parsed.data.projectId, parsed.data.trigger);
      // Starting or resuming is picked up immediately instead of on the next interval.
      if (status === 'RUNNING') void runtime.automation?.tick();
      return { success: true, status, project: repo.getProjectMetadata(parsed.data.projectId) };
    } catch (error) {
      // Repository identity failures keep their typed code through the registration wrapper.
      if (error instanceof RepositoryRootError) throw error;
      const message = error instanceof Error ? error.message : '';
      const errorCode = message.includes('Invalid transition') ? 'INVALID_TRANSITION'
        : message.includes('EMERGENCY_STOP_LATCHED') ? 'EMERGENCY_STOP_LATCHED'
        : /not found/i.test(message) ? 'PROJECT_NOT_FOUND' : 'TRANSITION_REJECTED';
      return { success: false, errorCode, error: redactSensitiveText(message || 'Project transition was rejected.') };
    }
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
    if (repo.isProjectTrashed(parsed.data.projectId)) return [];
    return repo.getTasksByProject(parsed.data.projectId).filter((task) => !repo.isTaskTrashed(task.id));
  });

  // Task-scoped coder context (#261): the same validation as planning and dispatch.
  const contextTask = (projectId: string, taskId: string) => {
    const project = repo.getProject(projectId);
    const task = repo.getTask(taskId);
    return project && task && task.project_id === project.id ? { project, task } : null;
  };

  registerPrivilegedHandler('task:getContextPaths', async (_, payload: unknown) => {
    const parsed = TaskContextPathsIpcSchema.safeParse(payload);
    if (!parsed.success) return { success: false, errorCode: 'INVALID_INPUT' };
    if (!contextTask(parsed.data.projectId, parsed.data.taskId)) return { success: false, errorCode: 'TASK_NOT_FOUND' };
    return { success: true, paths: repo.getTaskContextPaths(parsed.data.projectId, parsed.data.taskId) };
  });

  registerPrivilegedHandler('task:setContextPaths', async (_, payload: unknown) => {
    const parsed = SetTaskContextPathsIpcSchema.safeParse(payload);
    if (!parsed.success) return { success: false, errorCode: 'INVALID_INPUT' };
    const scoped = contextTask(parsed.data.projectId, parsed.data.taskId);
    if (!scoped) return { success: false, errorCode: 'TASK_NOT_FOUND' };
    const requested = parsed.data.paths.map((value) => value.trim()).filter(Boolean);
    const check = validateContextPaths(scoped.project.repository_path, requested);
    if (!check.ok) return { success: false, errorCode: check.reasonCode, path: check.path };
    repo.setTaskContextPaths(scoped.project.id, scoped.task.id, check.paths);
    return { success: true, paths: check.paths };
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

    const protocolScope = parseRes.data.data as { project_id?: unknown; task_id?: unknown };
    const trashed = trashRejection(protocolScope.project_id, protocolScope.task_id);
    if (trashed) return trashed;

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

  registerPrivilegedHandler('verification:saveCommands', async (event, payload: unknown) => {
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
      // authorize a command, even when the sender frame is trusted. The local MCP
      // caller acts on the owner's explicit delegation (enabling the server), and
      // its CLI agent can already run commands on this machine (#289).
      if (!isMcpCaller(event)) {
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
      }
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

  // Owner agent roster management. Every mutation is one immediate transaction
  // and replies with a typed result; removal is reversible and fenced by
  // active-work blockers.
  registerPrivilegedHandler('agents:roster', async (_, payload: unknown) => {
    const includeRemoved = Boolean(payload && typeof payload === 'object' && (payload as { includeRemoved?: unknown }).includeRemoved === true);
    return sanitizeOutputValue(workspaceManagementService.listAgents({ includeRemoved }));
  });

  // Model picker (#263): the CLI's own list (Codex) or its latest-tracking aliases.
  const modelCatalog = runtime.models ?? new ModelCatalogService();
  registerPrivilegedHandler('agents:listModels', async (_, payload: unknown) => {
    const connection = AgentConnectionKindEnum.safeParse(payload && typeof payload === 'object' ? (payload as { connection?: unknown }).connection : undefined);
    if (!connection.success) return { success: false, errorCode: 'INVALID_INPUT' };
    return sanitizeOutputValue({ success: true, catalog: await modelCatalog.list(connection.data) });
  });

  registerPrivilegedHandler('agents:create', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.createAgent(payload));
  });

  registerPrivilegedHandler('agents:update', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.updateAgent(payload));
  });

  registerPrivilegedHandler('agents:remove', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.removeAgent(payload));
  });

  registerPrivilegedHandler('agents:restore', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.restoreAgent(payload));
  });

  // Desktop runtime status and read-only quota telemetry.
  registerPrivilegedHandler('automation:status', async () => {
    if (!runtime.automation) return { success: false, errorCode: 'AUTOMATION_UNAVAILABLE' };
    return { success: true, status: runtime.automation.getStatus() };
  });

  // Automated Manager (#239): the owner's mode and decisions on its proposals.
  const readProjectId = (payload: unknown) => {
    const value = payload && typeof payload === 'object' ? (payload as { projectId?: unknown }).projectId : undefined;
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && repo.getProjectMetadata(value) ? value : null;
  };
  registerPrivilegedHandler('automation:managerDecisions', async (_, payload: unknown) => {
    const manager = runtime.automation?.getManager();
    const projectId = readProjectId(payload);
    if (!manager) return { success: false, errorCode: 'AUTOMATION_UNAVAILABLE' };
    if (!projectId) return { success: false, errorCode: 'PROJECT_NOT_FOUND' };
    return sanitizeOutputValue({ success: true, mode: manager.getMode(projectId), proposals: manager.listProposals(projectId) });
  });
  registerPrivilegedHandler('automation:setManagerMode', async (_, payload: unknown) => {
    const projectId = readProjectId(payload);
    const mode = payload && typeof payload === 'object' ? (payload as { mode?: unknown }).mode : undefined;
    if (!projectId) return { success: false, errorCode: 'PROJECT_NOT_FOUND' };
    if (mode !== 'AUTO' && mode !== 'APPROVE') return { success: false, errorCode: 'MANAGER_MODE_INVALID' };
    repo.setProjectManagerMode(projectId, mode);
    void runtime.automation?.tick();
    return { success: true, mode };
  });
  // How many of the project's tasks coders work on at once (#306).
  registerPrivilegedHandler('automation:getParallelTasks', async (_, payload: unknown) => {
    const projectId = readProjectId(payload);
    if (!projectId) return { success: false, errorCode: 'PROJECT_NOT_FOUND' };
    return { success: true, parallelTasks: repo.getProjectParallelTasks(projectId) };
  });
  registerPrivilegedHandler('automation:setParallelTasks', async (_, payload: unknown) => {
    const projectId = readProjectId(payload);
    const count = payload && typeof payload === 'object' ? (payload as { parallelTasks?: unknown }).parallelTasks : undefined;
    if (!projectId) return { success: false, errorCode: 'PROJECT_NOT_FOUND' };
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10) return { success: false, errorCode: 'PARALLEL_TASKS_INVALID' };
    repo.setProjectParallelTasks(projectId, count);
    void runtime.automation?.tick();
    return { success: true, parallelTasks: count };
  });
  // Owner retry of a NEEDS_HUMAN task with more revisions (#318).
  registerPrivilegedHandler('task:retry', async (_, payload: unknown) => {
    const target = readIntegrationTarget(payload);
    if (!target) return { success: false, errorCode: 'TASK_NOT_FOUND' };
    const result = taskService.retryNeedsHumanTask(target.projectId, target.taskId);
    if (result.success) void runtime.automation?.tick();
    return sanitizeOutputValue(result);
  });
  registerPrivilegedHandler('automation:decideManagerProposal', async (_, payload: unknown) => {
    const manager = runtime.automation?.getManager();
    const projectId = readProjectId(payload);
    const body = payload && typeof payload === 'object' ? payload as { eventId?: unknown; approve?: unknown } : {};
    if (!manager) return { success: false, errorCode: 'AUTOMATION_UNAVAILABLE' };
    if (!projectId || typeof body.eventId !== 'string' || body.eventId.length > 200 || typeof body.approve !== 'boolean') {
      return { success: false, errorCode: 'PROPOSAL_NOT_FOUND' };
    }
    const result = await manager.decideProposal(projectId, body.eventId, body.approve);
    if (result.success) void runtime.automation?.tick();
    return sanitizeOutputValue(result);
  });

  // Owner-controlled integration of reviewed work (#238): list, create a branch, discard.
  const readIntegrationTarget = (payload: unknown) => {
    const body = payload && typeof payload === 'object' ? payload as { projectId?: unknown; taskId?: unknown } : {};
    const ok = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
    return ok(body.projectId) && ok(body.taskId) ? { projectId: body.projectId, taskId: body.taskId } : null;
  };
  registerPrivilegedHandler('integration:list', async (_, payload: unknown) => {
    const projectId = readProjectId(payload);
    if (!runtime.automation) return { success: false, errorCode: 'AUTOMATION_UNAVAILABLE' };
    if (!projectId) return { success: false, errorCode: 'PROJECT_NOT_FOUND' };
    return sanitizeOutputValue({ success: true, entries: runtime.automation.getIntegration().list(projectId) });
  });
  // Automatic integration into the default branch (owner opt-in per project).
  registerPrivilegedHandler('integration:getAuto', async (_, payload: unknown) => {
    const projectId = readProjectId(payload);
    if (!projectId || !repo.getProject(projectId)) return { success: false, errorCode: 'PROJECT_NOT_FOUND' };
    return { success: true, enabled: repo.getProjectAutoIntegrate(projectId) };
  });
  registerPrivilegedHandler('integration:setAuto', async (_, payload: unknown) => {
    const projectId = readProjectId(payload);
    const enabled = payload && typeof payload === 'object' ? (payload as { enabled?: unknown }).enabled : undefined;
    if (!projectId || !repo.getProject(projectId)) return { success: false, errorCode: 'PROJECT_NOT_FOUND' };
    if (typeof enabled !== 'boolean') return { success: false, errorCode: 'INVALID_INPUT' };
    repo.setProjectAutoIntegrate(projectId, enabled);
    if (enabled) void runtime.automation?.tick();
    return { success: true, enabled };
  });
  registerPrivilegedHandler('integration:createBranch', async (_, payload: unknown) => {
    const target = readIntegrationTarget(payload);
    if (!runtime.automation) return { success: false, errorCode: 'AUTOMATION_UNAVAILABLE' };
    if (!target) return { success: false, errorCode: 'TASK_NOT_FOUND' };
    return sanitizeOutputValue(await runtime.automation.getIntegration().createBranch(target.projectId, target.taskId));
  });
  registerPrivilegedHandler('integration:merge', async (_, payload: unknown) => {
    const target = readIntegrationTarget(payload);
    if (!runtime.automation) return { success: false, errorCode: 'AUTOMATION_UNAVAILABLE' };
    if (!target) return { success: false, errorCode: 'TASK_NOT_FOUND' };
    return sanitizeOutputValue(await runtime.automation.getIntegration().mergeIntoDefault(target.projectId, target.taskId));
  });
  registerPrivilegedHandler('integration:discard', async (_, payload: unknown) => {
    const target = readIntegrationTarget(payload);
    if (!runtime.automation) return { success: false, errorCode: 'AUTOMATION_UNAVAILABLE' };
    if (!target) return { success: false, errorCode: 'TASK_NOT_FOUND' };
    return sanitizeOutputValue(await runtime.automation.getIntegration().discard(target.projectId, target.taskId));
  });

  registerPrivilegedHandler('quota:list', async () => {
    if (!runtime.quota) return { success: false, errorCode: 'QUOTA_UNAVAILABLE' };
    return sanitizeOutputValue({ success: true, observations: runtime.quota.getLatestObservations() });
  });

  registerPrivilegedHandler('quota:getPreferences', async () => {
    if (!runtime.quota) return { success: false, errorCode: 'QUOTA_UNAVAILABLE' };
    return { success: true, unofficialReaders: runtime.quota.getUnofficialReadersEnabled() };
  });

  // The owner's switch for reading Claude Code / Gemini usage from their saved sign-in (#250).
  registerPrivilegedHandler('quota:setPreferences', async (_, payload: unknown) => {
    if (!runtime.quota) return { success: false, errorCode: 'QUOTA_UNAVAILABLE' };
    const enabled = payload && typeof payload === 'object' ? (payload as { unofficialReaders?: unknown }).unofficialReaders : undefined;
    if (typeof enabled !== 'boolean') return { success: false, errorCode: 'INVALID_INPUT' };
    try {
      runtime.quota.setUnofficialReadersEnabled(enabled);
    } catch {
      return { success: false, errorCode: 'QUOTA_PREFERENCES_UNWRITABLE' };
    }
    return { success: true, unofficialReaders: enabled };
  });

  registerPrivilegedHandler('quota:refresh', async () => {
    if (!runtime.quota) return { success: false, errorCode: 'QUOTA_UNAVAILABLE' };
    const observations = await runtime.quota.refreshAll();
    // A newly verified account may make queued work schedulable.
    void runtime.automation?.tick();
    return sanitizeOutputValue({ success: true, observations });
  });

  // Optional Codex device-code sign-in into the account's isolated profile.
  // The renderer only ever sees the one-time code and a session id; the
  // verification page is opened from the URL held by the main process.
  const readSessionId = (payload: unknown) => {
    const value = payload && typeof payload === 'object' ? (payload as { sessionId?: unknown }).sessionId : undefined;
    return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
  };
  // Claude Code / Gemini sign-in: open the CLI's own login for the account's profile, then verify it.
  const readAccountId = (payload: unknown) => {
    const value = payload && typeof payload === 'object' ? (payload as { accountId?: unknown }).accountId : undefined;
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  };
  registerPrivilegedHandler('accounts:startCliSignIn', async (_, payload: unknown) => {
    const accountId = readAccountId(payload);
    if (!runtime.cliSignIn) return { success: false, errorCode: 'SIGN_IN_UNAVAILABLE' };
    if (!accountId) return { success: false, errorCode: 'ACCOUNT_NOT_FOUND' };
    return runtime.cliSignIn.startSignIn(accountId);
  });
  registerPrivilegedHandler('accounts:verifyCliSignIn', async (_, payload: unknown) => {
    const accountId = readAccountId(payload);
    if (!runtime.cliSignIn) return { success: false, errorCode: 'SIGN_IN_UNAVAILABLE' };
    if (!accountId) return { success: false, errorCode: 'ACCOUNT_NOT_FOUND' };
    return sanitizeOutputValue(await runtime.cliSignIn.verify(accountId));
  });
  registerPrivilegedHandler('accounts:startCodexSignIn', async (_, payload: unknown) => {
    if (!runtime.signIn) return { success: false, errorCode: 'SIGN_IN_UNAVAILABLE' };
    const accountId = payload && typeof payload === 'object' ? (payload as { accountId?: unknown }).accountId : undefined;
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) return { success: false, errorCode: 'ACCOUNT_NOT_FOUND' };
    return runtime.signIn.startDeviceLogin(accountId);
  });
  registerPrivilegedHandler('accounts:codexSignInStatus', async (_, payload: unknown) => {
    const sessionId = readSessionId(payload);
    const status = runtime.signIn && sessionId ? runtime.signIn.getLoginStatus(sessionId) : null;
    return status ? { success: true, status } : { success: false, errorCode: 'SESSION_NOT_FOUND' };
  });
  registerPrivilegedHandler('accounts:cancelCodexSignIn', async (_, payload: unknown) => {
    const sessionId = readSessionId(payload);
    if (!runtime.signIn || !sessionId) return { success: false, errorCode: 'SESSION_NOT_FOUND' };
    runtime.signIn.cancelLogin(sessionId);
    return { success: true };
  });
  registerPrivilegedHandler('accounts:openCodexSignInPage', async (_, payload: unknown) => {
    const sessionId = readSessionId(payload);
    const status = runtime.signIn && sessionId ? runtime.signIn.getLoginStatus(sessionId) : null;
    if (!status || status.state !== 'WAITING_FOR_USER' || !status.verificationUrl) return { success: false, errorCode: 'SESSION_NOT_FOUND' };
    const url = new URL(status.verificationUrl);
    if (url.protocol !== 'https:') return { success: false, errorCode: 'PROTOCOL_ERROR' };
    await shell.openExternal(url.toString());
    return { success: true };
  });

  // Owner trash for projects and tasks: reversible, history-preserving.
  registerPrivilegedHandler('trash:list', async () => {
    return sanitizeOutputValue(workspaceManagementService.listTrash());
  });

  registerPrivilegedHandler('trash:project', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.trashProject(payload));
  });

  registerPrivilegedHandler('trash:restoreProject', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.restoreProject(payload));
  });

  registerPrivilegedHandler('trash:task', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.trashTask(payload));
  });

  registerPrivilegedHandler('trash:restoreTask', async (_, payload: unknown) => {
    return sanitizeOutputValue(workspaceManagementService.restoreTask(payload));
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
  // Local MCP server settings (#289): renderer only, never invokable over MCP.
  registerPrivilegedHandler('mcp:getSettings', async () => {
    if (!runtime.mcp) return { success: false, errorCode: 'MCP_UNAVAILABLE' };
    return { success: true, settings: runtime.mcp.getSettings() };
  });
  registerPrivilegedHandler('mcp:setEnabled', async (_, payload: unknown) => {
    const enabled = payload && typeof payload === 'object' ? (payload as { enabled?: unknown }).enabled : undefined;
    if (!runtime.mcp) return { success: false, errorCode: 'MCP_UNAVAILABLE' };
    if (typeof enabled !== 'boolean') return { success: false, errorCode: 'INVALID_INPUT' };
    return runtime.mcp.setEnabled(enabled);
  });
  registerPrivilegedHandler('mcp:regenerateToken', async () => {
    if (!runtime.mcp) return { success: false, errorCode: 'MCP_UNAVAILABLE' };
    return runtime.mcp.regenerateToken();
  });

  return {
    invoke: async (channel, payload) => {
      const run = MCP_INVOKABLE_CHANNELS.has(channel) ? fencedHandlers.get(channel) : undefined;
      if (!run) throw new Error(`MCP_CHANNEL_NOT_ALLOWED: ${channel}`);
      return run(MCP_CALLER_EVENT, payload);
    },
    selectRepositoryPath: (repositoryPath) => selectRepository(repositoryPath),
  };
}
