import { ipcMain, dialog, app } from 'electron';
import path from 'path';
import { Repository } from '../core/database/repositories';
import { ProjectService } from '../core/services/ProjectService';
import { TaskService } from '../core/services/TaskService';
import { GitService } from '../core/services/GitService';
import { VerificationService } from '../core/services/VerificationService';
import { ProtocolParser } from '../core/protocol/parser';
import { PackageGenerator } from '../core/protocol/packageGenerator';
import { defaultArtifactStore } from '../core/services/ArtifactStore';
import { EmergencyStopService } from '../core/services/EmergencyStopService';
import { PolicyService } from '../core/services/PolicyService';
import { RepositorySelectionService } from '../core/services/RepositorySelectionService';
import { ProviderRoutingService } from '../core/services/ProviderRoutingService';
import { ExecutionAuthorizationService } from '../core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../core/services/ProviderDispatchService';
import { UpdateService } from '../core/services/UpdateService';
import { CommandParser } from '../core/services/CommandParser';
import {
  CreateProjectIpcSchema,
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
} from '../core/types/ipc';

export function registerIpcHandlers(
  repo: Repository,
  projectService: ProjectService,
  taskService: TaskService,
  verificationService: VerificationService,
  emergencyStopService: EmergencyStopService,
  providerRoutingService?: ProviderRoutingService,
  executionAuthorizationService?: ExecutionAuthorizationService,
  providerDispatchService?: ProviderDispatchService,
  updateService?: UpdateService
): void {
  // ==========================================
  // Trusted Repository Selection Dialog
  // ==========================================
  ipcMain.handle('dialog:selectRepository', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (canceled || filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    const selectedPath = path.normalize(path.resolve(filePaths[0]));

    // Validate path against security policy
    const policy = PolicyService.evaluatePathAccess(selectedPath, selectedPath, false);
    if (!policy.allowed) {
      return {
        success: false,
        errorCode: 'INVALID_REPOSITORY_LOCATION',
        errorDetail: policy.reason,
        error: `Invalid repository location: ${policy.reason}`,
      };
    }

    // Verify directory is a genuine Git working tree
    const gitStatus = await GitService.getStatus(selectedPath);
    if (gitStatus.status !== 'SUCCESS') {
      const errorDetail = gitStatus.errorMessage || 'git status failed';
      return {
        success: false,
        errorCode: 'NOT_GIT_REPOSITORY',
        errorDetail,
        error: `Selected directory is not a valid Git repository (${errorDetail}).`,
      };
    }

    // Issue short-lived, single-use selection token
    const token = RepositorySelectionService.issueToken(selectedPath);

    return {
      success: true,
      selectionId: token.selectionId,
      displayPath: token.displayPath,
    };
  });

  // ==========================================
  // Projects
  // ==========================================
  ipcMain.handle('project:create', async (_, payload: unknown) => {
    const parsed = CreateProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    // Consume native selection token
    const tokenRes = RepositorySelectionService.consumeToken(parsed.data.repositorySelectionId);
    if (!tokenRes.success || !tokenRes.canonicalPath) {
      return { success: false, error: tokenRes.error || 'Invalid repository selection token.' };
    }

    const canonicalRepoPath = tokenRes.canonicalPath;

    // Validate path security and Git repository validity
    const policy = PolicyService.evaluatePathAccess(canonicalRepoPath, canonicalRepoPath, false);
    if (!policy.allowed) {
      return { success: false, error: `Unauthorized repository path: ${policy.reason}` };
    }

    const gitStatus = await GitService.getStatus(canonicalRepoPath);
    if (gitStatus.status !== 'SUCCESS') {
      return {
        success: false,
        error: `Repository path is not a valid Git repository: ${gitStatus.errorMessage || 'git status failed'}`,
      };
    }

    const project = projectService.createProject(
      parsed.data.name,
      parsed.data.description,
      canonicalRepoPath,
      parsed.data.defaultBranch
    );

    return { success: true, project };
  });

  ipcMain.handle('project:get', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return null;
    return repo.getProject(parsed.data.projectId);
  });

  ipcMain.handle('project:list', async () => {
    return repo.getAllProjects();
  });

  ipcMain.handle('project:importContract', async (_, payload: unknown) => {
    const parsed = ImportContractIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return projectService.importContract(parsed.data.projectId, parsed.data.contract as any);
  });

  ipcMain.handle('project:transition', async (_, payload: unknown) => {
    const parsed = TransitionProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return projectService.transitionStatus(parsed.data.projectId, parsed.data.trigger);
  });

  // ==========================================
  // Tasks
  // ==========================================
  ipcMain.handle('task:create', async (_, payload: unknown) => {
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

  ipcMain.handle('task:get', async (_, payload: unknown) => {
    const parsed = TaskScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return null;
    return repo.getTask(parsed.data.taskId);
  });

  ipcMain.handle('task:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return repo.getTasksByProject(parsed.data.projectId);
  });

  ipcMain.handle('task:startReview', async (_, payload: unknown) => {
    const parsed = TaskScopedIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return taskService.startReview(parsed.data.taskId);
  });

  // ==========================================
  // Protocols & Package Generation
  // ==========================================
  ipcMain.handle('protocol:parse', async (_, payload: unknown) => {
    const parsed = ParseProtocolIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return ProtocolParser.parse(parsed.data.rawInput);
  });

  ipcMain.handle('protocol:apply', async (_, payload: unknown) => {
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

  ipcMain.handle('protocol:generateWorkOrder', async (_, payload: unknown) => {
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

  ipcMain.handle('protocol:generateReviewPackage', async (_, payload: unknown) => {
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

    if (!gitDiffEv) {
      return {
        success: false,
        error: 'AUTHORITATIVE_DIFF_EVIDENCE_MISSING: No durable Git diff validation evidence found for this task. Run validation flow before requesting review.',
      };
    }

    // Atomically advance task to REVIEWING if in REVIEW_READY
    if (task.state === 'REVIEW_READY') {
      const reviewStartRes = taskService.startReview(task.id, project.id);
      if (reviewStartRes.success && reviewStartRes.task) {
        task = reviewStartRes.task;
      }
    }

    let diffContent = '';
    const diffStat = gitDiffEv.summary || 'Git Diff recorded.';

    try {
      diffContent = defaultArtifactStore.read(gitDiffEv);
    } catch {
      diffContent = gitDiffEv.raw_payload || '';
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

    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      task,
      coderReport,
      diffStat,
      diffContent,
      latestTestRun,
      reviews,
      gitDiffEv
    );

    return { success: true, reviewPackage };
  });

  // ==========================================
  // Git & Verification (Derives path securely from SQLite)
  // ==========================================
  ipcMain.handle('git:getStatus', async (_, payload: unknown) => {
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

    return GitService.getStatus(project.repository_path);
  });

  ipcMain.handle('git:getDiff', async (_, payload: unknown) => {
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

    return GitService.getDiff(project.repository_path, task.base_sha);
  });

  ipcMain.handle('verification:runTests', async (_, payload: unknown) => {
    const parsed = RunVerificationIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    return taskService.executeValidationFlow(parsed.data.taskId, parsed.data.commandConfigId);
  });

  ipcMain.handle('verification:getCommands', async (_, payload: unknown) => {
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

  ipcMain.handle('verification:saveCommands', async (_, payload: unknown) => {
    const parsed = SaveVerificationCommandsIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const project = repo.getProject(parsed.data.projectId);
    if (!project) {
      return { success: false, error: `Project "${parsed.data.projectId}" not found.` };
    }

    const parsedCommands: {
      TEST?: { executable: string; args: string[] } | null;
      LINT?: { executable: string; args: string[] } | null;
      BUILD?: { executable: string; args: string[] } | null;
    } = {};

    const types: Array<'TEST' | 'LINT' | 'BUILD'> = ['TEST', 'LINT', 'BUILD'];
    for (const type of types) {
      const rawCmd = parsed.data.commands[type];
      if (rawCmd != null && rawCmd.trim().length > 0) {
        let parsedCmd;
        try {
          parsedCmd = CommandParser.parse(rawCmd);
        } catch (err: any) {
          return { success: false, error: `Invalid ${type} command: ${err.message}` };
        }

        if (parsedCmd) {
          const policy = PolicyService.evaluateProcessExecution(parsedCmd.executable, parsedCmd.args, false);
          if (!policy.allowed) {
            return {
              success: false,
              error: `Security policy rejected ${type} command "${rawCmd}": ${policy.reason} (${policy.decision})`,
            };
          }
          parsedCommands[type] = parsedCmd;
        } else {
          parsedCommands[type] = null;
        }
      } else {
        parsedCommands[type] = null;
      }
    }

    try {
      const updatedCommands = repo.setProjectVerificationCommands(project.id, parsedCommands);
      return { success: true, commands: updatedCommands };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to save verification commands.' };
    }
  });

  // ==========================================
  // Providers & Agents
  // ==========================================
  ipcMain.handle('providers:listResources', async () => {
    return repo.getAllProviderResources();
  });

  ipcMain.handle('agents:list', async () => {
    return repo.getAllAgents();
  });

  ipcMain.handle('providers:updateResourceQuota', async (_, payload: unknown) => {
    const parsed = UpdateResourceQuotaIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    repo.updateProviderResourceQuota(
      parsed.data.id,
      parsed.data.remaining,
      parsed.data.total,
      parsed.data.source,
      parsed.data.confidence
    );
    return { success: true };
  });

  // ==========================================
  // Events & Evidence Queries
  // ==========================================
  ipcMain.handle('events:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return repo.getEventsByProject(parsed.data.projectId);
  });

  ipcMain.handle('evidence:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return repo.getEvidenceByProject(parsed.data.projectId);
  });

  // ==========================================
  // Emergency Controls
  // ==========================================
  ipcMain.handle('control:emergencyStop', async (_, payload: unknown) => {
    const parsed = EmergencyStopIpcSchema.safeParse(payload || {});
    const reason = parsed.success ? parsed.data.reason : 'Manual Owner Emergency Stop';
    return emergencyStopService.triggerEmergencyStop(reason);
  });

  ipcMain.handle('control:resume', async (_, payload: unknown) => {
    const parsed = ResumeProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    return emergencyStopService.resumeProject(parsed.data.projectId);
  });

  // ==========================================
  // PR #8: Owner Routing & Manual Bridge Handoff
  // ==========================================

  ipcMain.handle('routing:routeTask', async (_, payload: unknown) => {
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

  ipcMain.handle('routing:authorizeTask', async (_, payload: unknown) => {
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

  ipcMain.handle('routing:dispatchAuthorization', async (_, payload: unknown) => {
    if (!providerDispatchService) {
      return { success: false, error: 'ProviderDispatchService unavailable.' };
    }
    const parsed = DispatchAuthorizationIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    try {
      const result = await providerDispatchService.dispatch(parsed.data.authorizationId);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: err.message || 'Dispatch failed.' };
    }
  });

  ipcMain.handle('routing:getHandoffSnapshot', async (_, payload: unknown) => {
    const parsed = GetOwnerHandoffSnapshotIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const task = repo.getTask(parsed.data.taskId);
    if (!task) {
      return { success: false, error: `Task "${parsed.data.taskId}" not found.` };
    }

    const project = repo.getProject(task.project_id);
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
      const headRes = await GitService.getHeadSha(project.repository_path);
      if (headRes.status === 'SUCCESS' && headRes.sha) {
        gitHeadSha = headRes.sha;
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

  ipcMain.handle('routing:generateAuthorizedWorkOrder', async (_, payload: unknown) => {
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

  ipcMain.handle('app:getInfo', async (_, payload: unknown) => {
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

  ipcMain.handle('update:getState', async (_, payload: unknown) => {
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

  ipcMain.handle('update:check', async (_, payload: unknown) => {
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

  ipcMain.handle('update:download', async (_, payload: unknown) => {
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

  ipcMain.handle('update:installAndRestart', async (_, payload: unknown) => {
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
}
