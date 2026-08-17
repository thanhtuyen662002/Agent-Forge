import { ipcMain } from 'electron';
import { defaultDb } from '../core/database/db';
import { Repository } from '../core/database/repositories';
import { EventService } from '../core/services/EventService';
import { ProjectService } from '../core/services/ProjectService';
import { TaskService } from '../core/services/TaskService';
import { GitService } from '../core/services/GitService';
import { VerificationService } from '../core/services/VerificationService';
import { ArtifactStore } from '../core/services/ArtifactStore';
import { EmergencyStopService } from '../core/services/EmergencyStopService';
import { ProtocolParser } from '../core/protocol/parser';
import { PackageGenerator } from '../core/protocol/packageGenerator';
import { ManagerProtocol, CoderProtocol } from '../core/types/protocols';
import { ProjectTrigger } from '../core/state/projectStateMachine';

export function registerIpcHandlers(): void {
  const db = defaultDb.getDb();
  const repo = new Repository(db);
  const eventService = new EventService(repo);
  const projectService = new ProjectService(repo, eventService);
  const taskService = new TaskService(repo, eventService);
  const artifactStore = new ArtifactStore();
  const verificationService = new VerificationService(repo, artifactStore);
  const emergencyStopService = new EmergencyStopService(repo, eventService);

  // ==========================================
  // Projects
  // ==========================================
  ipcMain.handle('orchestrator:getProjects', async () => {
    return repo.getAllProjects();
  });

  ipcMain.handle('orchestrator:createProject', async (_, data) => {
    return projectService.createProject(
      data.name,
      data.description,
      data.repositoryPath,
      data.defaultBranch ?? 'main'
    );
  });

  ipcMain.handle('orchestrator:importContract', async (_, data) => {
    return projectService.importContract(data.projectId, data.contract);
  });

  ipcMain.handle('orchestrator:transitionProject', async (_, data) => {
    return projectService.transitionStatus(data.projectId, data.trigger as ProjectTrigger);
  });

  // ==========================================
  // Tasks
  // ==========================================
  ipcMain.handle('orchestrator:getTasks', async (_, projectId: string) => {
    return repo.getTasksByProject(projectId);
  });

  ipcMain.handle('orchestrator:getTask', async (_, taskId: string) => {
    return repo.getTask(taskId);
  });

  ipcMain.handle('orchestrator:createTask', async (_, taskData) => {
    repo.createTask(taskData);
    eventService.record(
      taskData.project_id,
      'TASK_CREATED',
      `Task "${taskData.title}" (${taskData.id}) created in state ${taskData.state}.`,
      taskData,
      taskData.id
    );
  });

  // ==========================================
  // Protocols & Manual Bridge
  // ==========================================
  ipcMain.handle('orchestrator:parseProtocol', async (_, input: string) => {
    return ProtocolParser.parse(input);
  });

  ipcMain.handle('orchestrator:applyManagerProtocol', async (_, data) => {
    return taskService.applyManagerDecision(
      data.managerMsg as ManagerProtocol,
      data.rawPayload,
      data.payloadHash
    );
  });

  ipcMain.handle('orchestrator:applyCoderProtocol', async (_, data) => {
    return taskService.applyCoderReport(
      data.coderMsg as CoderProtocol,
      data.rawPayload,
      data.payloadHash
    );
  });

  ipcMain.handle('orchestrator:generateWorkOrder', async (_, data) => {
    const project = repo.getProject(data.projectId);
    const task = repo.getTask(data.taskId);
    if (!project || !task) throw new Error('Project or task not found.');
    return PackageGenerator.generateWorkOrder(project, task, {
      test: data.testCmd,
      lint: data.lintCmd,
      build: data.buildCmd,
    });
  });

  ipcMain.handle('orchestrator:generateReviewPackage', async (_, data) => {
    const project = repo.getProject(data.projectId);
    const task = repo.getTask(data.taskId);
    if (!project || !task) throw new Error('Project or task not found.');

    const gitDiff = await GitService.getDiff(project.repository_path, task.base_sha);
    const previousReviews = repo.getReviewsByTask(task.id);

    return PackageGenerator.generateReviewPackage(
      project,
      task,
      data.coderReport,
      gitDiff.diffStat,
      gitDiff.diffContent,
      null,
      previousReviews
    );
  });

  // ==========================================
  // Git & Verification
  // ==========================================
  ipcMain.handle('orchestrator:getGitStatus', async (_, repoPath: string) => {
    return GitService.getStatus(repoPath);
  });

  ipcMain.handle('orchestrator:getGitDiff', async (_, repoPath: string, baseSha?: string) => {
    return GitService.getDiff(repoPath, baseSha);
  });

  ipcMain.handle('orchestrator:runVerificationTests', async (_, data) => {
    const testRun = await verificationService.runTests(
      data.projectId,
      data.taskId,
      null,
      data.repoPath,
      data.command || 'npm test'
    );

    // If tests ran, update current SHA from git
    const headSha = await GitService.getHeadSha(data.repoPath);
    repo.updateTaskShas(data.taskId, undefined, headSha);

    return testRun;
  });

  // ==========================================
  // Evidence & Events
  // ==========================================
  ipcMain.handle('orchestrator:getEvidence', async (_, projectId: string) => {
    return repo.getAllEvidence(projectId);
  });

  ipcMain.handle('orchestrator:getEvents', async (_, projectId?: string) => {
    return eventService.getEvents(projectId, 150);
  });

  // ==========================================
  // Providers & Quota
  // ==========================================
  ipcMain.handle('orchestrator:getProviders', async () => {
    return repo.getAllProviders();
  });

  ipcMain.handle('orchestrator:getProviderResources', async () => {
    return repo.getAllProviderResources();
  });

  ipcMain.handle('orchestrator:updateResourceQuota', async (_, data) => {
    repo.updateProviderResourceQuota(
      data.id,
      data.remaining,
      data.total,
      data.source,
      data.confidence
    );
  });

  // ==========================================
  // Emergency Stop & Safety
  // ==========================================
  ipcMain.handle('orchestrator:triggerEmergencyStop', async (_, reason?: string) => {
    return emergencyStopService.triggerEmergencyStop(reason);
  });

  ipcMain.handle('orchestrator:resumeProject', async (_, projectId: string) => {
    return emergencyStopService.resumeProject(projectId);
  });
}
