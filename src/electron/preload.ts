import { contextBridge, ipcRenderer } from 'electron';

export interface OrchestratorApi {
  // Projects
  getProjects: () => Promise<any[]>;
  createProject: (data: { name: string; description: string; repositoryPath: string; defaultBranch?: string }) => Promise<any>;
  importContract: (data: { projectId: string; contract: any }) => Promise<boolean>;
  transitionProject: (data: { projectId: string; trigger: string }) => Promise<string>;

  // Tasks
  getTasks: (projectId: string) => Promise<any[]>;
  getTask: (taskId: string) => Promise<any>;
  createTask: (data: any) => Promise<void>;

  // Manual Bridge & Protocols
  parseProtocol: (input: string) => Promise<any>;
  applyManagerProtocol: (data: { managerMsg: any; rawPayload: string; payloadHash: string }) => Promise<any>;
  applyCoderProtocol: (data: { coderMsg: any; rawPayload: string; payloadHash: string }) => Promise<any>;
  generateWorkOrder: (data: { projectId: string; taskId: string; testCmd?: string; lintCmd?: string; buildCmd?: string }) => Promise<string>;
  generateReviewPackage: (data: { projectId: string; taskId: string; coderReport: any }) => Promise<string>;

  // Git & Verification
  getGitStatus: (repoPath: string) => Promise<any>;
  getGitDiff: (repoPath: string, baseSha?: string) => Promise<any>;
  runVerificationTests: (data: { projectId: string; taskId: string; repoPath: string; command?: string }) => Promise<any>;

  // Evidence & Events
  getEvidence: (projectId: string) => Promise<any[]>;
  getEvents: (projectId?: string) => Promise<any[]>;

  // Providers & Resources
  getProviders: () => Promise<any[]>;
  getProviderResources: () => Promise<any[]>;
  updateResourceQuota: (data: { id: string; remaining: number; total: number | null; source: string; confidence: number }) => Promise<void>;

  // Safety & Emergency Stop
  triggerEmergencyStop: (reason?: string) => Promise<any>;
  resumeProject: (projectId: string) => Promise<boolean>;
}

const api: OrchestratorApi = {
  getProjects: () => ipcRenderer.invoke('orchestrator:getProjects'),
  createProject: (data) => ipcRenderer.invoke('orchestrator:createProject', data),
  importContract: (data) => ipcRenderer.invoke('orchestrator:importContract', data),
  transitionProject: (data) => ipcRenderer.invoke('orchestrator:transitionProject', data),

  getTasks: (projectId) => ipcRenderer.invoke('orchestrator:getTasks', projectId),
  getTask: (taskId) => ipcRenderer.invoke('orchestrator:getTask', taskId),
  createTask: (data) => ipcRenderer.invoke('orchestrator:createTask', data),

  parseProtocol: (input) => ipcRenderer.invoke('orchestrator:parseProtocol', input),
  applyManagerProtocol: (data) => ipcRenderer.invoke('orchestrator:applyManagerProtocol', data),
  applyCoderProtocol: (data) => ipcRenderer.invoke('orchestrator:applyCoderProtocol', data),
  generateWorkOrder: (data) => ipcRenderer.invoke('orchestrator:generateWorkOrder', data),
  generateReviewPackage: (data) => ipcRenderer.invoke('orchestrator:generateReviewPackage', data),

  getGitStatus: (repoPath) => ipcRenderer.invoke('orchestrator:getGitStatus', repoPath),
  getGitDiff: (repoPath, baseSha) => ipcRenderer.invoke('orchestrator:getGitDiff', repoPath, baseSha),
  runVerificationTests: (data) => ipcRenderer.invoke('orchestrator:runVerificationTests', data),

  getEvidence: (projectId) => ipcRenderer.invoke('orchestrator:getEvidence', projectId),
  getEvents: (projectId) => ipcRenderer.invoke('orchestrator:getEvents', projectId),

  getProviders: () => ipcRenderer.invoke('orchestrator:getProviders'),
  getProviderResources: () => ipcRenderer.invoke('orchestrator:getProviderResources'),
  updateResourceQuota: (data) => ipcRenderer.invoke('orchestrator:updateResourceQuota', data),

  triggerEmergencyStop: (reason) => ipcRenderer.invoke('orchestrator:triggerEmergencyStop', reason),
  resumeProject: (projectId) => ipcRenderer.invoke('orchestrator:resumeProject', projectId),
};

contextBridge.exposeInMainWorld('orchestrator', api);
