import { ipcMain, dialog } from 'electron';
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
} from '../core/types/ipc';

export function registerIpcHandlers(
  repo: Repository,
  projectService: ProjectService,
  taskService: TaskService,
  verificationService: VerificationService,
  emergencyStopService: EmergencyStopService,
  providerRoutingService?: ProviderRoutingService,
  executionAuthorizationService?: ExecutionAuthorizationService,
  providerDispatchService?: ProviderDispatchService
): void {
  // ==========================================
  // Trusted Repository Selection Dialog
  // ==========================================
  ipcMain.handle('dialog:selectRepository', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Git Repository for Project',
    });

    if (canceled || filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    const selectedPath = path.normalize(path.resolve(filePaths[0]));

    // Validate path against security policy
    const policy = PolicyService.evaluatePathAccess(selectedPath, selectedPath, false);
    if (!policy.allowed) {
      return { success: false, error: `Invalid repository location: ${policy.reason}` };
    }

    // Verify directory is a genuine Git working tree
    const gitStatus = await GitService.getStatus(selectedPath);
    if (gitStatus.status !== 'SUCCESS') {
      return {
        success: false,
        error: `Selected directory is not a valid Git repository (${gitStatus.errorMessage || 'git status failed'}).`,
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

    const workOrder = PackageGenerator.generateWorkOrder(project, task);
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

    if (latestManagerRecord && latestManagerRecord.raw_payload) {
      const parsedProto = ProtocolParser.parse(String(latestManagerRecord.raw_payload));
      if (parsedProto.success && parsedProto.data?.type === 'manager.v1') {
        const mData = parsedProto.data.data;
        instructionsCount = Array.isArray(mData.instructions) ? mData.instructions.length : 0;
        const expectedRev = typeof mData.expected_revision === 'number' ? mData.expected_revision : null;
        if (mData.decision === 'EXECUTE') {
          hasAuthority = true;
          decisionValidForCurrentRevision = expectedRev === task.revision_count;
          if (!decisionValidForCurrentRevision) {
            authorityReason = `Manager EXECUTE expected revision (${expectedRev}) does not match task revision (${task.revision_count}).`;
          }
        } else if (mData.decision === 'FIX_REQUIRED') {
          hasAuthority = true;
          decisionValidForCurrentRevision = expectedRev !== null && expectedRev + 1 === task.revision_count;
          if (!decisionValidForCurrentRevision) {
            authorityReason = `Manager FIX_REQUIRED expected revision (${expectedRev !== null ? expectedRev + 1 : 'null'}) does not match task revision (${task.revision_count}).`;
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

    // Retrieve latest routing decision event from SQLite
    let latestRoutingDecision: any = null;
    if (project) {
      const events = repo.getEventsByProject(project.id, 50);
      const routingEvent = events.find(
        (e) =>
          e.type === 'PROVIDER_ROUTING_DECISION' &&
          (e.task_id === task.id || (e.structured_payload as any)?.taskId === task.id)
      );
      if (routingEvent && routingEvent.structured_payload) {
        latestRoutingDecision = routingEvent.structured_payload;
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
          decision: latestManagerRecord?.decision ? String(latestManagerRecord.decision) : null,
          payloadHash: latestManagerRecord?.payload_hash ? String(latestManagerRecord.payload_hash) : null,
          expectedRevision:
            latestManagerRecord?.expected_revision !== undefined ? Number(latestManagerRecord.expected_revision) : null,
          instructionsCount,
          createdAt: latestManagerRecord?.created_at ? String(latestManagerRecord.created_at) : null,
          decisionValidForCurrentRevision,
          reason: authorityReason,
        },
        gitHeadSha,
        providerResources,
        latestRoutingDecision,
        latestAuthorization,
      },
    };
  });
}
