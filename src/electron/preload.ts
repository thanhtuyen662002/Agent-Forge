import { contextBridge, ipcRenderer } from 'electron';

export interface OrchestratorApi {
  // Projects
  getProjects: () => Promise<any[]>;
  createProject: (data: { name: string; description?: string; repositoryPath: string; defaultBranch?: string }) => Promise<any>;
  importContract: (data: { projectId: string; contract: any }) => Promise<any>;
  transitionProject: (data: { projectId: string; trigger: string }) => Promise<any>;

  // Tasks
  getTasks: (projectId: string) => Promise<any[]>;
  getTask: (taskId: string) => Promise<any>;
  createTask: (data: any) => Promise<any>;

  // Protocols & Manual Bridge
  parseProtocol: (input: string) => Promise<any>;
  applyProtocol: (rawInput: string) => Promise<any>;
  generateWorkOrder: (data: { projectId: string; taskId: string }) => Promise<any>;
  generateReviewPackage: (data: { projectId: string; taskId: string }) => Promise<any>;

  // Git & Verification
  getGitStatus: (projectId: string) => Promise<any>;
  getGitDiff: (taskId: string) => Promise<any>;
  runVerificationTests: (taskId: string, commandConfigId?: string) => Promise<any>;

  // Agents & Resources
  getAgents: () => Promise<any[]>;
  getProviderResources: () => Promise<any[]>;
  updateResourceQuota: (data: { id: string; remaining: number | null; total: number | null; source: string; confidence: number }) => Promise<any>;

  // Evidence & Events
  getEvidence: (projectId: string) => Promise<any[]>;
  getEvents: (projectId: string) => Promise<any[]>;

  // Safety & Emergency Stop
  triggerEmergencyStop: (reason?: string) => Promise<any>;
  resumeProject: (projectId: string) => Promise<any>;
}

const api: OrchestratorApi = {
  getProjects: () => ipcRenderer.invoke('project:list'),
  createProject: (data) => ipcRenderer.invoke('project:create', data),
  importContract: (data) => ipcRenderer.invoke('project:importContract', data),
  transitionProject: (data) => ipcRenderer.invoke('project:transition', data),

  getTasks: (projectId) => ipcRenderer.invoke('task:list', { projectId }),
  getTask: (taskId) => ipcRenderer.invoke('task:get', { taskId }),
  createTask: (data) => ipcRenderer.invoke('task:create', data),

  parseProtocol: (input) => ipcRenderer.invoke('protocol:parse', { input }),
  applyProtocol: (rawInput) => ipcRenderer.invoke('protocol:apply', { rawInput }),
  generateWorkOrder: (data) => ipcRenderer.invoke('protocol:generateWorkOrder', data),
  generateReviewPackage: (data) => ipcRenderer.invoke('protocol:generateReviewPackage', data),

  getGitStatus: (projectId) => ipcRenderer.invoke('git:getStatus', { projectId }),
  getGitDiff: (taskId) => ipcRenderer.invoke('git:getDiff', { taskId }),
  runVerificationTests: (taskId, commandConfigId) => ipcRenderer.invoke('verification:runTests', { taskId, commandConfigId }),

  getAgents: () => ipcRenderer.invoke('agents:list'),
  getProviderResources: () => ipcRenderer.invoke('resources:list'),
  updateResourceQuota: (data) => ipcRenderer.invoke('resources:updateQuota', data),

  getEvidence: (projectId) => ipcRenderer.invoke('evidence:list', { projectId }),
  getEvents: (projectId) => ipcRenderer.invoke('events:list', { projectId }),

  triggerEmergencyStop: (reason) => ipcRenderer.invoke('emergency:stop', { reason }),
  resumeProject: (projectId) => ipcRenderer.invoke('emergency:resumeProject', { projectId }),
};

contextBridge.exposeInMainWorld('orchestrator', api);
