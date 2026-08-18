import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Project, Task, Agent, ProviderResource, EventRecord, Evidence, UIDensityMode } from '../../core/types/domain';

// Check if Electron IPC is available
const isElectron = typeof window !== 'undefined' && Boolean((window as any).orchestrator);
const orchestrator = isElectron ? (window as any).orchestrator : null;

interface OrchestratorContextType {
  isElectron: boolean;
  projects: Project[];
  activeProject: Project | null;
  tasks: Task[];
  agents: Agent[];
  resources: ProviderResource[];
  events: EventRecord[];
  evidence: Evidence[];
  densityMode: UIDensityMode;
  isEmergencyStopOpen: boolean;
  activeView: string;
  selectedTaskId: string | null;
  loading: boolean;
  setDensityMode: (mode: UIDensityMode) => void;
  setActiveProject: (project: Project | null) => void;
  setActiveView: (view: string) => void;
  setSelectedTaskId: (taskId: string | null) => void;
  setIsEmergencyStopOpen: (open: boolean) => void;
  refreshData: () => Promise<void>;
  createProject: (data: { name: string; description?: string; repositorySelectionId: string; defaultBranch?: string }) => Promise<Project>;
  importContract: (contract: any) => Promise<boolean>;
  transitionProject: (trigger: string) => Promise<void>;
  createTask: (spec: { title: string; description?: string | null; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; acceptanceCriteria?: string[]; constraints?: string[] }) => Promise<void>;
  parseProtocol: (input: string) => Promise<any>;
  applyProtocol: (rawInput: string) => Promise<any>;
  generateWorkOrder: (taskId: string) => Promise<string>;
  generateReviewPackage: (taskId: string) => Promise<string>;
  runVerificationTests: (taskId: string, commandConfigId?: string) => Promise<any>;
  updateResourceQuota: (id: string, remaining: number | null, total: number | null, source: string, confidence: number) => Promise<void>;
  triggerEmergencyStop: (reason?: string) => Promise<any>;
  resumeProject: () => Promise<void>;
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
}

const OrchestratorContext = createContext<OrchestratorContextType | null>(null);

export const OrchestratorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [resources, setResources] = useState<ProviderResource[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [densityMode, setDensityMode] = useState<UIDensityMode>('OWNER');
  const [isEmergencyStopOpen, setIsEmergencyStopOpen] = useState<boolean>(false);
  const [activeView, setActiveView] = useState<string>('dashboard');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const refreshData = useCallback(async () => {
    if (!orchestrator) {
      // Browser preview fallback with unmeasured initial values
      const mockProj: Project = {
        id: 'PROJ-DEMO',
        name: 'Agent-Forge Core Engine',
        description: 'Local AI engineering orchestrator desktop platform',
        repository_path: 'd:\\Projects\\Agent-Forge',
        default_branch: 'main',
        status: 'READY',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      };
      setProjects([mockProj]);
      setActiveProject((prev) => prev || mockProj);

      setTasks([
        {
          id: 'AUTH-014',
          project_id: 'PROJ-DEMO',
          milestone_id: null,
          title: 'Implement JWT Validation and Verification Middleware',
          description: 'Add token signature verification, claims validation, and test suite.',
          state: 'PLANNED',
          paused_from_state: null,
          priority: 'HIGH',
          risk: 'MEDIUM',
          assigned_agent_id: 'agent-gemini-coder',
          revision_count: 0,
          max_revisions: 3,
          base_sha: 'HEAD',
          current_sha: null,
          progress_cache_percent: 0,
          progress_computed_at: new Date().toISOString(),
          acceptance_criteria: ['Returns 401 on expired token', 'All unit tests pass'],
          constraints: ['Do not modify user schema'],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      setAgents([
        {
          id: 'agent-primary-manager',
          display_name: 'ChatGPT Manager (Manual)',
          role: 'PRIMARY_MANAGER',
          provider_resource_id: 'res-chatgpt-manager',
          status: 'ACTIVE',
          current_task_id: null,
          last_seen_at: new Date().toISOString(),
        },
        {
          id: 'agent-gemini-coder',
          display_name: 'Gemini Coder (Manual)',
          role: 'CODER',
          provider_resource_id: 'res-gemini-coder',
          status: 'IDLE',
          current_task_id: null,
          last_seen_at: new Date().toISOString(),
        },
      ]);

      setResources([
        {
          id: 'res-chatgpt-manager',
          provider_id: 'prov-manual-bridge',
          model_name: 'ChatGPT Manager',
          health_status: 'UNKNOWN',
          capabilities: ['PLANNING', 'REVIEW', 'SECURITY_REVIEW', 'LARGE_CONTEXT'],
          enabled: true,
          total_quota: null,
          remaining_quota: null,
          quota_unit: 'REQUESTS',
          quota_reset_at: null,
          quota_source: 'UNKNOWN',
          quota_confidence: 0.0,
          last_health_check: null,
        },
        {
          id: 'res-gemini-coder',
          provider_id: 'prov-manual-bridge',
          model_name: 'Gemini Coder',
          health_status: 'UNKNOWN',
          capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'LARGE_CONTEXT'],
          enabled: true,
          total_quota: null,
          remaining_quota: null,
          quota_unit: 'REQUESTS',
          quota_reset_at: null,
          quota_source: 'UNKNOWN',
          quota_confidence: 0.0,
          last_health_check: null,
        },
      ]);
      return;
    }

    try {
      const projList = await orchestrator.getProjects();
      setProjects(projList);

      const currentProj = activeProject || projList[0] || null;
      setActiveProject(currentProj);

      if (currentProj) {
        const [taskList, eventList, evidenceList] = await Promise.all([
          orchestrator.getTasks(currentProj.id),
          orchestrator.getEvents(currentProj.id),
          orchestrator.getEvidence(currentProj.id),
        ]);
        setTasks(taskList);
        setEvents(eventList);
        setEvidence(evidenceList);
      }

      // Load real DB-backed agents and resources
      const [resList, agentList] = await Promise.all([
        orchestrator.getProviderResources(),
        orchestrator.getAgents(),
      ]);
      setResources(resList);
      setAgents(agentList);
    } catch (err) {
      console.error('[OrchestratorContext] Error refreshing data:', err);
    }
  }, [activeProject]);

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 3000);
    return () => clearInterval(interval);
  }, [refreshData]);

  const createProject = async (data: { name: string; description?: string; repositorySelectionId: string; defaultBranch?: string }) => {
    if (!orchestrator) throw new Error('Desktop IPC unavailable.');
    const res = await orchestrator.createProject(data);
    await refreshData();
    if (res && res.project) {
      setActiveProject(res.project);
      return res.project;
    }
    return res;
  };

  const importContract = async (contract: any) => {
    if (!orchestrator || !activeProject) return false;
    const ok = await orchestrator.importContract({ projectId: activeProject.id, contract });
    await refreshData();
    return ok;
  };

  const transitionProject = async (trigger: string) => {
    if (!orchestrator || !activeProject) return;
    await orchestrator.transitionProject({ projectId: activeProject.id, trigger });
    await refreshData();
  };

  const createTask = async (spec: { title: string; description?: string | null; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; acceptanceCriteria?: string[]; constraints?: string[] }) => {
    if (!orchestrator || !activeProject) return;
    await orchestrator.createTask({
      projectId: activeProject.id,
      title: spec.title,
      description: spec.description,
      priority: spec.priority || 'MEDIUM',
      risk: spec.risk || 'MEDIUM',
      acceptanceCriteria: spec.acceptanceCriteria || [],
      constraints: spec.constraints || [],
    });
    await refreshData();
  };

  const parseProtocol = async (input: string) => {
    if (!orchestrator) {
      return { success: false, error: 'Protocol parser requires Electron desktop shell.' };
    }
    return orchestrator.parseProtocol(input);
  };

  const applyProtocol = async (rawInput: string) => {
    if (!orchestrator) return { success: false, error: 'Desktop shell required' };
    const res = await orchestrator.applyProtocol(rawInput);
    await refreshData();
    return res;
  };

  const generateWorkOrder = async (taskId: string) => {
    if (!orchestrator || !activeProject) return 'Desktop required.';
    const res = await orchestrator.generateWorkOrder({ projectId: activeProject.id, taskId });
    return res.workOrder || res;
  };

  const generateReviewPackage = async (taskId: string) => {
    if (!orchestrator || !activeProject) return 'Desktop required.';
    const res = await orchestrator.generateReviewPackage({ projectId: activeProject.id, taskId });
    return res.reviewPackage || res;
  };

  const runVerificationTests = async (taskId: string, commandConfigId?: string) => {
    if (!orchestrator) throw new Error('Desktop IPC unavailable.');
    const res = await orchestrator.runVerificationTests(taskId, commandConfigId);
    await refreshData();
    return res;
  };

  const updateResourceQuota = async (
    id: string,
    remaining: number | null,
    total: number | null,
    source: string,
    confidence: number
  ) => {
    if (!orchestrator) return;
    await orchestrator.updateResourceQuota({ id, remaining, total, source, confidence });
    await refreshData();
  };

  const triggerEmergencyStop = async (reason?: string) => {
    if (!orchestrator) return;
    const res = await orchestrator.triggerEmergencyStop(reason);
    await refreshData();
    return res;
  };

  const resumeProject = async () => {
    if (!orchestrator || !activeProject) return;
    await orchestrator.resumeProject(activeProject.id);
    await refreshData();
  };

  const routeTask = async (data: {
    projectId: string;
    taskId: string;
    attemptId?: string | null;
    candidateResourceIds: string[];
    allowManualBridge: boolean;
  }) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const res = await orchestrator.routeTask(data);
    await refreshData();
    return res;
  };

  const authorizeRoutedTask = async (data: {
    projectId: string;
    taskId: string;
    attemptId?: string | null;
    routingDecisionId: string;
    contextFiles?: string[];
  }) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const res = await orchestrator.authorizeRoutedTask(data);
    await refreshData();
    return res;
  };

  const dispatchAuthorization = async (authorizationId: string) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const res = await orchestrator.dispatchAuthorization(authorizationId);
    await refreshData();
    return res;
  };

  const getOwnerHandoffSnapshot = async (taskId: string) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    return orchestrator.getOwnerHandoffSnapshot(taskId);
  };

  const generateAuthorizedWorkOrder = async (authorizationId: string) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    return orchestrator.generateAuthorizedWorkOrder(authorizationId);
  };

  return (
    <OrchestratorContext.Provider
      value={{
        isElectron,
        projects,
        activeProject,
        tasks,
        agents,
        resources,
        events,
        evidence,
        densityMode,
        isEmergencyStopOpen,
        activeView,
        selectedTaskId,
        loading,
        setDensityMode,
        setActiveProject,
        setActiveView,
        setSelectedTaskId,
        setIsEmergencyStopOpen,
        refreshData,
        createProject,
        importContract,
        transitionProject,
        createTask,
        parseProtocol,
        applyProtocol,
        generateWorkOrder,
        generateReviewPackage,
        runVerificationTests,
        updateResourceQuota,
        triggerEmergencyStop,
        resumeProject,
        routeTask,
        authorizeRoutedTask,
        dispatchAuthorization,
        getOwnerHandoffSnapshot,
        generateAuthorizedWorkOrder,
      }}
    >
      {children}
    </OrchestratorContext.Provider>
  );
};

export const useOrchestrator = () => {
  const context = useContext(OrchestratorContext);
  if (!context) {
    throw new Error('useOrchestrator must be used within an OrchestratorProvider');
  }
  return context;
};
