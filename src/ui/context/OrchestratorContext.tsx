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
  createProject: (data: { name: string; description: string; repositoryPath: string; defaultBranch?: string }) => Promise<Project>;
  importContract: (contract: any) => Promise<boolean>;
  transitionProject: (trigger: string) => Promise<void>;
  createTask: (task: Partial<Task>) => Promise<void>;
  parseProtocol: (input: string) => Promise<any>;
  applyManagerProtocol: (data: { managerMsg: any; rawPayload: string; payloadHash: string }) => Promise<any>;
  applyCoderProtocol: (data: { coderMsg: any; rawPayload: string; payloadHash: string }) => Promise<any>;
  generateWorkOrder: (taskId: string) => Promise<string>;
  generateReviewPackage: (taskId: string, coderReport: any) => Promise<string>;
  runVerificationTests: (taskId: string, command?: string) => Promise<any>;
  updateResourceQuota: (id: string, remaining: number, total: number | null, source: string, confidence: number) => Promise<void>;
  triggerEmergencyStop: (reason?: string) => Promise<any>;
  resumeProject: () => Promise<void>;
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
      // Mock data for preview mode
      const mockProj: Project = {
        id: 'PROJ-DEMO',
        name: 'Agent-Forge Core Engine',
        description: 'Local AI engineering orchestrator desktop platform',
        repository_path: 'd:\\Projects\\Agent-Forge',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
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
          state: 'CODING',
          paused_from_state: null,
          priority: 'HIGH',
          risk: 'MEDIUM',
          assigned_agent_id: 'agent-gemini-coder',
          revision_count: 1,
          max_revisions: 3,
          base_sha: '7a8b9c0',
          current_sha: 'd1e2f3a',
          progress_cache_percent: 62,
          progress_computed_at: new Date().toISOString(),
          acceptance_criteria: ['Returns 401 on expired token', 'All unit tests pass'],
          constraints: ['Do not modify user schema'],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 'SEC-021',
          project_id: 'PROJ-DEMO',
          milestone_id: null,
          title: 'Audit ProcessRunner Shell Security and Path Restrictions',
          description: 'Verify shell is disabled by default and credential paths are blocked.',
          state: 'REVIEW_READY',
          paused_from_state: null,
          priority: 'CRITICAL',
          risk: 'HIGH',
          assigned_agent_id: 'agent-primary-manager',
          revision_count: 0,
          max_revisions: 3,
          base_sha: '7a8b9c0',
          current_sha: 'b4c5d6e',
          progress_cache_percent: 85,
          progress_computed_at: new Date().toISOString(),
          acceptance_criteria: ['Path boundaries enforced', 'Secret redaction active'],
          constraints: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      setAgents([
        {
          id: 'agent-primary-manager',
          display_name: 'GPT Manager',
          role: 'PRIMARY_MANAGER',
          provider_resource_id: 'res-chatgpt-manager',
          status: 'ACTIVE',
          current_task_id: 'SEC-021',
          last_seen_at: new Date().toISOString(),
        },
        {
          id: 'agent-gemini-coder',
          display_name: 'Gemini Coder #1',
          role: 'CODER',
          provider_resource_id: 'res-gemini-coder',
          status: 'ACTIVE',
          current_task_id: 'AUTH-014',
          last_seen_at: new Date().toISOString(),
        },
      ]);

      setResources([
        {
          id: 'res-chatgpt-manager',
          provider_id: 'prov-manual-bridge',
          model_name: 'ChatGPT Manager (GPT-4o)',
          health_status: 'AVAILABLE',
          capabilities: ['PLANNING', 'REVIEW', 'SECURITY_REVIEW'],
          enabled: true,
          total_quota: 100,
          remaining_quota: 85,
          quota_unit: 'REQUESTS',
          quota_reset_at: null,
          quota_source: 'MANUAL',
          quota_confidence: 0.9,
          last_health_check: new Date().toISOString(),
        },
        {
          id: 'res-gemini-coder',
          provider_id: 'prov-manual-bridge',
          model_name: 'Gemini Coder (Gemini 1.5 Pro)',
          health_status: 'AVAILABLE',
          capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
          enabled: true,
          total_quota: 50,
          remaining_quota: 42,
          quota_unit: 'REQUESTS',
          quota_reset_at: null,
          quota_source: 'MANUAL',
          quota_confidence: 0.95,
          last_health_check: new Date().toISOString(),
        },
      ]);

      setEvents([
        {
          id: 'ev-1',
          project_id: 'PROJ-DEMO',
          task_id: 'AUTH-014',
          agent_id: 'agent-gemini-coder',
          type: 'CODER_REPORT_APPLIED',
          summary: 'Coder submitted report for AUTH-014. Status: COMPLETED.',
          structured_payload: { status: 'COMPLETED' },
          timestamp: new Date().toISOString(),
        },
        {
          id: 'ev-2',
          project_id: 'PROJ-DEMO',
          task_id: 'AUTH-014',
          agent_id: null,
          type: 'TEST_RUN_PASSED',
          summary: 'Verification test suite passed: 142 passed, 0 failed.',
          structured_payload: { passed: 142, failed: 0 },
          timestamp: new Date(Date.now() - 60000).toISOString(),
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

      const [resList] = await Promise.all([
        orchestrator.getProviderResources(),
      ]);
      setResources(resList);
    } catch (err) {
      console.error('[OrchestratorContext] Error refreshing data:', err);
    }
  }, [activeProject]);

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 3000);
    return () => clearInterval(interval);
  }, [refreshData]);

  const createProject = async (data: { name: string; description: string; repositoryPath: string; defaultBranch?: string }) => {
    if (!orchestrator) throw new Error('Desktop IPC unavailable.');
    const proj = await orchestrator.createProject(data);
    await refreshData();
    setActiveProject(proj);
    return proj;
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

  const createTask = async (task: Partial<Task>) => {
    if (!orchestrator || !activeProject) return;
    await orchestrator.createTask({
      ...task,
      project_id: activeProject.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await refreshData();
  };

  const parseProtocol = async (input: string) => {
    if (!orchestrator) {
      // Fallback for browser preview
      return { success: false, error: 'Protocol parser requires Electron desktop shell.' };
    }
    return orchestrator.parseProtocol(input);
  };

  const applyManagerProtocol = async (data: { managerMsg: any; rawPayload: string; payloadHash: string }) => {
    if (!orchestrator) return { success: false, error: 'Desktop shell required' };
    const res = await orchestrator.applyManagerProtocol(data);
    await refreshData();
    return res;
  };

  const applyCoderProtocol = async (data: { coderMsg: any; rawPayload: string; payloadHash: string }) => {
    if (!orchestrator) return { success: false, error: 'Desktop shell required' };
    const res = await orchestrator.applyCoderProtocol(data);
    await refreshData();
    return res;
  };

  const generateWorkOrder = async (taskId: string) => {
    if (!orchestrator || !activeProject) return 'Desktop required.';
    return orchestrator.generateWorkOrder({ projectId: activeProject.id, taskId });
  };

  const generateReviewPackage = async (taskId: string, coderReport: any) => {
    if (!orchestrator || !activeProject) return 'Desktop required.';
    return orchestrator.generateReviewPackage({ projectId: activeProject.id, taskId, coderReport });
  };

  const runVerificationTests = async (taskId: string, command?: string) => {
    if (!orchestrator || !activeProject) return null;
    const res = await orchestrator.runVerificationTests({
      projectId: activeProject.id,
      taskId,
      repoPath: activeProject.repository_path,
      command,
    });
    await refreshData();
    return res;
  };

  const updateResourceQuota = async (id: string, remaining: number, total: number | null, source: string, confidence: number) => {
    if (!orchestrator) return;
    await orchestrator.updateResourceQuota({ id, remaining, total, source, confidence });
    await refreshData();
  };

  const triggerEmergencyStop = async (reason?: string) => {
    if (!orchestrator) return null;
    const res = await orchestrator.triggerEmergencyStop(reason);
    await refreshData();
    return res;
  };

  const resumeProject = async () => {
    if (!orchestrator || !activeProject) return;
    await orchestrator.resumeProject(activeProject.id);
    await refreshData();
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
        applyManagerProtocol,
        applyCoderProtocol,
        generateWorkOrder,
        generateReviewPackage,
        runVerificationTests,
        updateResourceQuota,
        triggerEmergencyStop,
        resumeProject,
      }}
    >
      {children}
    </OrchestratorContext.Provider>
  );
};

export const useOrchestrator = () => {
  const ctx = useContext(OrchestratorContext);
  if (!ctx) throw new Error('useOrchestrator must be used within OrchestratorProvider');
  return ctx;
};
