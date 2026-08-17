import { ipcMain } from 'electron';
import { defaultDb } from '../core/database/db';
import { Repository } from '../core/database/repositories';
import { EventService } from '../core/services/EventService';
import { ProjectService } from '../core/services/ProjectService';
import { TaskService } from '../core/services/TaskService';
import { GitService } from '../core/services/GitService';
import { VerificationService } from '../core/services/VerificationService';
import { defaultArtifactStore } from '../core/services/ArtifactStore';
import { EmergencyStopService } from '../core/services/EmergencyStopService';
import { ProtocolParser } from '../core/protocol/parser';
import { PackageGenerator } from '../core/protocol/packageGenerator';
import {
  CreateProjectIpcSchema,
  ImportContractIpcSchema,
  TransitionProjectIpcSchema,
  GetTasksIpcSchema,
  GetTaskIpcSchema,
  CreateTaskIpcSchema,
  ParseProtocolIpcSchema,
  ApplyProtocolIpcSchema,
  GenerateWorkOrderIpcSchema,
  GenerateReviewPackageIpcSchema,
  ProjectScopedIpcSchema,
  TaskScopedIpcSchema,
  RunVerificationIpcSchema,
  UpdateResourceQuotaIpcSchema,
  EmergencyStopIpcSchema,
  ResumeProjectIpcSchema,
} from '../core/types/ipc';

export function registerIpcHandlers(): void {
  const db = defaultDb.getDb();
  const repo = new Repository(db);
  const eventService = new EventService(repo);
  const projectService = new ProjectService(repo, eventService);
  const verificationService = new VerificationService(repo, defaultArtifactStore);
  const taskService = new TaskService(repo, eventService, verificationService, defaultArtifactStore, defaultDb);
  const emergencyStopService = new EmergencyStopService(repo, eventService);

  // ==========================================
  // Projects
  // ==========================================
  ipcMain.handle('project:create', async (_, payload: unknown) => {
    const parsed = CreateProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return projectService.createProject(parsed.data.name, parsed.data.description, parsed.data.repositoryPath);
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
  ipcMain.handle('task:list', async (_, payload: unknown) => {
    const parsed = GetTasksIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return repo.getTasksByProject(parsed.data.projectId);
  });

  ipcMain.handle('task:get', async (_, payload: unknown) => {
    const parsed = GetTaskIpcSchema.safeParse(payload);
    if (!parsed.success) return null;
    return repo.getTask(parsed.data.taskId);
  });

  ipcMain.handle('task:create', async (_, payload: unknown) => {
    const parsed = CreateTaskIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    const now = new Date().toISOString();
    const task = {
      id: parsed.data.id,
      project_id: parsed.data.project_id,
      milestone_id: parsed.data.milestone_id ?? null,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      state: 'CREATED' as const,
      paused_from_state: null,
      priority: parsed.data.priority,
      risk: parsed.data.risk,
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: parsed.data.acceptance_criteria,
      constraints: parsed.data.constraints,
      created_at: now,
      updated_at: now,
    };
    repo.createTask(task);
    return { success: true, task };
  });

  // ==========================================
  // Protocols & Manual Bridge
  // ==========================================
  ipcMain.handle('protocol:parse', async (_, payload: unknown) => {
    const parsed = ParseProtocolIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return ProtocolParser.parse(parsed.data.input);
  });

  ipcMain.handle('protocol:apply', async (_, payload: unknown) => {
    const parsed = ApplyProtocolIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }

    const parseResult = ProtocolParser.parse(parsed.data.rawInput);
    if (!parseResult.success || !parseResult.protocolType || !parseResult.data) {
      return { success: false, error: parseResult.error || 'Failed to parse protocol envelope.' };
    }

    if (parseResult.protocolType === 'manager.v1') {
      return taskService.applyManagerDecision(parseResult.data as any, parsed.data.rawInput);
    } else if (parseResult.protocolType === 'coder.v1') {
      return taskService.applyCoderReport(parseResult.data as any, parsed.data.rawInput);
    }

    return { success: false, error: `Unsupported protocol type for auto-apply: ${parseResult.protocolType}` };
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
    const task = repo.getTask(parsed.data.taskId);
    if (!project || !task) {
      return { success: false, error: 'Project or Task not found.' };
    }

    // Authoritative evidence loaded from SQLite
    const latestTestRun = repo.getLatestTestRun(task.id);
    const gitDiffEv = repo.getLatestEvidence(task.id, 'GIT_DIFF');
    const reviews = repo.getReviewsByTask(task.id);

    const diffContent = gitDiffEv ? defaultArtifactStore.read(gitDiffEv) : '';
    const diffStat = gitDiffEv ? gitDiffEv.summary : 'No Git diff evidence recorded.';

    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      task,
      null,
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
  // Resources & Agents
  // ==========================================
  ipcMain.handle('resources:list', async () => {
    return repo.getAllProviderResources();
  });

  ipcMain.handle('resources:updateQuota', async (_, payload: unknown) => {
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

  ipcMain.handle('agents:list', async () => {
    return repo.getAllAgents();
  });

  // ==========================================
  // Evidence & Audit Events
  // ==========================================
  ipcMain.handle('evidence:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return repo.getAllEvidence(parsed.data.projectId);
  });

  ipcMain.handle('events:list', async (_, payload: unknown) => {
    const parsed = ProjectScopedIpcSchema.safeParse(payload);
    if (!parsed.success) return [];
    return repo.getEventsByProject(parsed.data.projectId);
  });

  // ==========================================
  // Safety & Emergency Stop
  // ==========================================
  ipcMain.handle('emergency:stop', async (_, payload: unknown) => {
    const parsed = EmergencyStopIpcSchema.safeParse(payload);
    const reason = parsed.success ? parsed.data.reason : 'Manual Owner Emergency Stop';
    return emergencyStopService.triggerEmergencyStop(reason);
  });

  ipcMain.handle('emergency:resumeProject', async (_, payload: unknown) => {
    const parsed = ResumeProjectIpcSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
    }
    return emergencyStopService.resumeProject(parsed.data.projectId);
  });
}
