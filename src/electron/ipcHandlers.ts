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
import {
  CreateProjectIpcSchema,
  ImportContractIpcSchema,
  TransitionProjectIpcSchema,
  CreateTaskIpcSchema,
  ApplyProtocolIpcSchema,
  GenerateWorkOrderIpcSchema,
  GenerateReviewPackageIpcSchema,
  UpdateResourceQuotaIpcSchema,
  ProjectScopedIpcSchema,
  TaskScopedIpcSchema,
  RunVerificationIpcSchema,
} from '../core/types/ipc';

export function registerIpcHandlers(
  repo: Repository,
  projectService: ProjectService,
  taskService: TaskService,
  verificationService: VerificationService,
  emergencyStopService: EmergencyStopService
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

    return { success: true, repositoryPath: selectedPath };
  });

  // ==========================================
  // Projects
  // ==========================================
  ipcMain.handle('project:create', async (_, payload: unknown) => {
    const parsed = CreateProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const repoPath = path.normalize(path.resolve(parsed.data.repositoryPath));

    // Validate path security and Git repository validity
    const policy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!policy.allowed) {
      return { success: false, error: `Unauthorized repository path: ${policy.reason}` };
    }

    const gitStatus = await GitService.getStatus(repoPath);
    if (gitStatus.status !== 'SUCCESS') {
      return {
        success: false,
        error: `Repository path is not a valid Git repository: ${gitStatus.errorMessage || 'git status failed'}`,
      };
    }

    return projectService.createProject(parsed.data.name, parsed.data.description, repoPath);
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
    return projectService.transitionStatus(parsed.data.projectId, parsed.data.trigger as any);
  });

  // ==========================================
  // Tasks
  // ==========================================
  ipcMain.handle('task:create', async (_, payload: unknown) => {
    const parsed = CreateTaskIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return repo.createTask(parsed.data as any);
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
  ipcMain.handle('protocol:parse', async (_, rawInput: string) => {
    return ProtocolParser.parse(rawInput);
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
      return taskService.applyManagerDecision(parseRes.data.data, parsed.data.rawInput);
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

    // Atomically advance task to REVIEWING if in REVIEW_READY
    if (task.state === 'REVIEW_READY') {
      const reviewStartRes = taskService.startReview(task.id);
      if (reviewStartRes.success && reviewStartRes.task) {
        task = reviewStartRes.task;
      }
    }

    // Authoritative evidence loaded from SQLite
    const latestTestRun = repo.getLatestTestRun(task.id);
    const gitDiffEv = repo.getLatestEvidence(task.id, 'GIT_DIFF');
    const reviews = repo.getReviewsByTask(task.id);

    let diffContent = '';
    let diffStat = 'No Git diff evidence recorded.';

    if (gitDiffEv) {
      try {
        diffContent = defaultArtifactStore.read(gitDiffEv);
        diffStat = gitDiffEv.summary;
      } catch {
        diffContent = gitDiffEv.raw_payload || '';
      }
    } else {
      // Fallback: query live git diff
      const liveDiff = await GitService.getDiff(project.repository_path, task.base_sha);
      if (liveDiff.status === 'SUCCESS') {
        diffContent = liveDiff.diffContent;
        diffStat = liveDiff.diffStat;
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

    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      task,
      coderReport,
      diffStat,
      diffContent,
      latestTestRun,
      reviews
    );

    return { success: true, reviewPackage };
  });

  // ==========================================
  // Git & Verification (Derives path securely from SQLite)
  // ==========================================
  ipcMain.handle('git:getStatus', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { status: 'ERROR', branch: 'UNKNOWN', isClean: false, modifiedFiles: [], untrackedFiles: [], aheadCount: 0, behindCount: 0, errorMessage: 'Invalid project ID' };
    }

    const project = repo.getProject(parsed.data.projectId);
    if (!project) {
      return { status: 'ERROR', branch: 'UNKNOWN', isClean: false, modifiedFiles: [], untrackedFiles: [], aheadCount: 0, behindCount: 0, errorMessage: 'Project not found' };
    }

    return GitService.getStatus(project.repository_path);
  });

  ipcMain.handle('git:getDiff', async (_, payload: unknown) => {
    const parsed = TaskScopedIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { status: 'ERROR', diffStat: '', diffContent: '', filesChanged: [], insertions: 0, deletions: 0, errorMessage: 'Invalid task ID' };
    }

    const task = repo.getTask(parsed.data.taskId);
    if (!task) {
      return { status: 'ERROR', diffStat: '', diffContent: '', filesChanged: [], insertions: 0, deletions: 0, errorMessage: 'Task not found' };
    }

    const project = repo.getProject(task.project_id);
    if (!project) {
      return { status: 'ERROR', diffStat: '', diffContent: '', filesChanged: [], insertions: 0, deletions: 0, errorMessage: 'Project not found' };
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
  ipcMain.handle('control:emergencyStop', async (_, reason?: string) => {
    return emergencyStopService.triggerEmergencyStop(reason);
  });

  ipcMain.handle('control:resume', async (_, projectId: string) => {
    return emergencyStopService.resumeProject(projectId);
  });
}
