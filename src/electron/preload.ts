import { contextBridge, ipcRenderer } from 'electron';

export interface OrchestratorApi {
  // Repository Dialog
  selectRepositoryDirectory: () => Promise<{
    success: boolean;
    selectionId?: string;
    displayPath?: string;
    errorCode?: 'NOT_GIT_REPOSITORY' | 'INVALID_REPOSITORY_LOCATION' | 'UNKNOWN_ERROR';
    errorDetail?: string;
    error?: string;
    cancelled?: boolean;
  }>;

  // Projects
  getProjects: () => Promise<any[]>;
  createProject: (data: { name: string; description?: string; repositorySelectionId: string; defaultBranch?: string }) => Promise<any>;
  importContract: (data: { projectId: string; contract: any }) => Promise<any>;
  transitionProject: (data: { projectId: string; trigger: string }) => Promise<any>;

  // Tasks
  getTasks: (projectId: string) => Promise<any[]>;
  getTask: (taskId: string) => Promise<any>;
  createTask: (data: {
    projectId: string;
    id?: string;
    milestoneId?: string | null;
    title: string;
    description?: string | null;
    priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    acceptanceCriteria?: string[];
    constraints?: string[];
  }) => Promise<any>;
  startReview: (taskId: string) => Promise<any>;

  // Protocols & Manual Bridge
  parseProtocol: (rawInput: string) => Promise<any>;
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

  // PR #8: Owner Routing & Manual Bridge Handoff
  routeTask: (data: {
    projectId: string;
    taskId: string;
    attemptId?: string | null;
    candidateResourceIds: string[];
    allowManualBridge: boolean;
  }) => Promise<any>;
  authorizeRoutedTask: (data: {
    projectId: string;
    taskId: string;
    attemptId?: string | null;
    routingDecisionId: string;
    contextFiles?: string[];
  }) => Promise<any>;
  dispatchAuthorization: (authorizationId: string) => Promise<any>;
  getOwnerHandoffSnapshot: (taskId: string) => Promise<any>;
  generateAuthorizedWorkOrder: (authorizationId: string) => Promise<any>;

  // PR #9: App Info & Updates
  getAppInfo: () => Promise<any>;
  getUpdateState: () => Promise<any>;
  checkForUpdates: () => Promise<any>;
  downloadUpdate: () => Promise<any>;
  installAndRestartUpdate: () => Promise<any>;

  // PR #14: Verification Commands Configuration
  getVerificationCommands: (projectId: string) => Promise<any>;
  saveVerificationCommands: (data: {
    projectId: string;
    commands: {
      TEST?: string | null;
      LINT?: string | null;
      BUILD?: string | null;
    };
  }) => Promise<any>;
}

const api: OrchestratorApi = {
  selectRepositoryDirectory: () => ipcRenderer.invoke('dialog:selectRepository'),
  getProjects: () => ipcRenderer.invoke('project:list'),
  createProject: (data) => ipcRenderer.invoke('project:create', data),
  importContract: (data) => ipcRenderer.invoke('project:importContract', data),
  transitionProject: (data) => ipcRenderer.invoke('project:transition', data),

  getTasks: (projectId: string) => ipcRenderer.invoke('task:list', { projectId }),
  getTask: (taskId: string) => ipcRenderer.invoke('task:get', { taskId }),
  createTask: (data) => ipcRenderer.invoke('task:create', data),
  startReview: (taskId: string) => ipcRenderer.invoke('task:startReview', { taskId }),

  parseProtocol: (rawInput: string) => ipcRenderer.invoke('protocol:parse', { rawInput }),
  applyProtocol: (rawInput: string) => ipcRenderer.invoke('protocol:apply', { rawInput }),
  generateWorkOrder: (data) => ipcRenderer.invoke('protocol:generateWorkOrder', data),
  generateReviewPackage: (data) => ipcRenderer.invoke('protocol:generateReviewPackage', data),

  getGitStatus: (projectId: string) => ipcRenderer.invoke('git:getStatus', { projectId }),
  getGitDiff: (taskId: string) => ipcRenderer.invoke('git:getDiff', { taskId }),
  runVerificationTests: (taskId: string, commandConfigId?: string) =>
    ipcRenderer.invoke('verification:runTests', { taskId, commandConfigId }),

  getAgents: () => ipcRenderer.invoke('agents:list'),
  getProviderResources: () => ipcRenderer.invoke('providers:listResources'),
  updateResourceQuota: (data) => ipcRenderer.invoke('providers:updateResourceQuota', data),

  getEvidence: (projectId: string) => ipcRenderer.invoke('evidence:list', { projectId }),
  getEvents: (projectId: string) => ipcRenderer.invoke('events:list', { projectId }),

  triggerEmergencyStop: (reason?: string) => ipcRenderer.invoke('control:emergencyStop', { reason }),
  resumeProject: (projectId: string) => ipcRenderer.invoke('control:resume', { projectId }),

  routeTask: (data) => ipcRenderer.invoke('routing:routeTask', data),
  authorizeRoutedTask: (data) => ipcRenderer.invoke('routing:authorizeTask', data),
  dispatchAuthorization: (authorizationId: string) =>
    ipcRenderer.invoke('routing:dispatchAuthorization', { authorizationId }),
  getOwnerHandoffSnapshot: (taskId: string) =>
    ipcRenderer.invoke('routing:getHandoffSnapshot', { taskId }),
  generateAuthorizedWorkOrder: (authorizationId: string) =>
    ipcRenderer.invoke('routing:generateAuthorizedWorkOrder', { authorizationId }),

  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installAndRestartUpdate: () => ipcRenderer.invoke('update:installAndRestart'),

  getVerificationCommands: (projectId: string) =>
    ipcRenderer.invoke('verification:getCommands', { projectId }),
  saveVerificationCommands: (data) =>
    ipcRenderer.invoke('verification:saveCommands', data),
};

contextBridge.exposeInMainWorld('orchestrator', api);
