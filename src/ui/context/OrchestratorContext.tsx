import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Project, Task, Agent, ProviderResource, EventRecord, Evidence, UIDensityMode } from '../../core/types/domain';
import type { CanonicalExecutionScope } from '../../core/services/ExecutionAuthorizationService';
import type { RendererAuthorizationMode } from '../../core/types/ipc';
import { UiActionName, UiActionResult, UiActionRunner, uiActionFailure } from '../actionState';

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
  refreshError: string | null;
  pendingActions: UiActionName[];
  actionResults: Partial<Record<UiActionName, UiActionResult<unknown>>>;
  setDensityMode: (mode: UIDensityMode) => void;
  setActiveProject: (project: Project | null) => void;
  setActiveView: (view: string) => void;
  setSelectedTaskId: (taskId: string | null) => void;
  setIsEmergencyStopOpen: (open: boolean) => void;
  refreshData: () => Promise<void>;
  createProject: (data: { name: string; description?: string; repositorySelectionId: string; defaultBranch?: string }) => Promise<UiActionResult<Project>>;
  importContract: (contract: any) => Promise<UiActionResult>;
  transitionProject: (trigger: string) => Promise<UiActionResult>;
  createTask: (spec: { title: string; description?: string | null; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; acceptanceCriteria?: string[]; constraints?: string[] }) => Promise<UiActionResult<Task>>;
  parseProtocol: (input: string) => Promise<any>;
  applyProtocol: (rawInput: string) => Promise<any>;
  generateWorkOrder: (taskId: string) => Promise<string>;
  generateReviewPackage: (taskId: string) => Promise<string>;
  runVerificationTests: (taskId: string, commandConfigId?: string) => Promise<any>;
  updateResourceQuota: (id: string, remaining: number | null, total: number | null, source: string, confidence: number) => Promise<void>;
  triggerEmergencyStop: (reason?: string) => Promise<any>;
  resumeProject: () => Promise<UiActionResult>;
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
    executionMode: RendererAuthorizationMode;
    assignmentId?: string;
    taskOwnershipEpoch?: number;
    contextManifestId?: string;
    executionScope?: CanonicalExecutionScope;
  }) => Promise<any>;
  dispatchAuthorization: (authorizationId: string, executionMode: RendererAuthorizationMode) => Promise<any>;
  getOwnerHandoffSnapshot: (taskId: string) => Promise<any>;
  generateAuthorizedWorkOrder: (authorizationId: string) => Promise<any>;
  getVerificationCommands: (projectId: string) => Promise<any>;
  saveVerificationCommands: (data: {
    projectId: string;
    commands: {
      TEST?: string | null;
      LINT?: string | null;
      BUILD?: string | null;
    };
  }) => Promise<any>;
  listQuarantinedSubmissions: (options?: {
    projectId?: string;
    taskId?: string;
    limit?: number;
    offset?: number;
    reverse?: boolean;
  }) => Promise<any>;
  inspectQuarantinedSubmission: (submissionId: string) => Promise<any>;
  admitQuarantinedSubmission: (submissionId: string, expectedLifecycleVersion?: number) => Promise<any>;
  rejectQuarantinedSubmission: (submissionId: string, expectedLifecycleVersion: number, reason: string) => Promise<any>;
  supersedeQuarantinedSubmission: (submissionId: string, expectedLifecycleVersion: number, replacementSubmissionId: string, reason: string) => Promise<any>;
  resumeAdmittedSubmission: (submissionId: string, adjudicationId: string, expectedLifecycleVersion: number) => Promise<any>;
  acknowledgeRecoveryFencedSubmission: (submissionId: string, adjudicationId: string, expectedLifecycleVersion: number, decision: 'ACKNOWLEDGE' | 'CANCEL') => Promise<any>;
}

const OrchestratorContext = createContext<OrchestratorContextType | null>(null);

/** Shared identity fence for UI requests that may resolve out of order. */
export function isAsyncResponseCurrent<T>(
  requestId: number,
  currentRequestId: number,
  requestedKey: T,
  currentKey: T
): boolean {
  return requestId === currentRequestId && requestedKey === currentKey;
}

/** Keep the current selection only when it still exists in the newest list. */
export function reconcileSelectedId<T extends { id: string }>(selectedId: string | null, items: T[]): string | null {
  if (selectedId && items.some((item) => item.id === selectedId)) return selectedId;
  return items[0]?.id ?? null;
}

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
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<UiActionName[]>([]);
  const [actionResults, setActionResults] = useState<Partial<Record<UiActionName, UiActionResult<unknown>>>>({});
  const actionRunnerRef = useRef<UiActionRunner | null>(null);
  if (!actionRunnerRef.current) actionRunnerRef.current = new UiActionRunner(isElectron, setPendingActions);
  const activeProjectRef = useRef<Project | null>(activeProject);
  const refreshRequestRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);

  useEffect(() => {
    activeProjectRef.current = activeProject;
  }, [activeProject]);

  const refreshData = useCallback(async () => {
    if (refreshInFlightRef.current) {
      // A mutation-triggered refresh must not overlap the polling request. Queue
      // one follow-up so the durable write is still reflected promptly.
      refreshPendingRef.current = true;
      return;
    }

    const requestId = ++refreshRequestRef.current;
    const requestedProjectId = activeProjectRef.current?.id ?? null;
    refreshInFlightRef.current = true;
    setLoading(true);
    setRefreshError(null);

    const isCurrentRequest = () => requestId === refreshRequestRef.current;
    const selectionUnchanged = () => isAsyncResponseCurrent(
      requestId,
      refreshRequestRef.current,
      requestedProjectId,
      activeProjectRef.current?.id ?? null
    );

    try {
      if (!orchestrator) {
        // Browser preview fallback with deterministic initial values.
        const now = new Date().toISOString();
        const mockProj: Project = {
          id: 'PROJ-DEMO',
          name: 'Agent-Forge Core Engine',
          description: 'Local AI engineering orchestrator desktop platform',
          repository_path: 'd:\\Projects\\Agent-Forge',
          default_branch: 'main',
          status: 'READY',
          contract: null,
          created_at: now,
          updated_at: now,
          started_at: null,
          completed_at: null,
        };
        if (!isCurrentRequest()) return;
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
            progress_computed_at: now,
            acceptance_criteria: ['Returns 401 on expired token', 'All unit tests pass'],
            constraints: ['Do not modify user schema'],
            created_at: now,
            updated_at: now,
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
            last_seen_at: now,
          },
          {
            id: 'agent-gemini-coder',
            display_name: 'Gemini Coder (Manual)',
            role: 'CODER',
            provider_resource_id: 'res-gemini-coder',
            status: 'IDLE',
            current_task_id: null,
            last_seen_at: now,
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

      const projList = await orchestrator.getProjects();
      if (!isCurrentRequest() || !selectionUnchanged()) return;

      const currentProj = (requestedProjectId
        ? projList.find((project: Project) => project.id === requestedProjectId)
        : projList[0]) || null;
      setProjects(projList);
      setActiveProject(currentProj);

      if (currentProj) {
        const [taskList, eventList, evidenceList] = await Promise.all([
          orchestrator.getTasks(currentProj.id),
          orchestrator.getEvents(currentProj.id),
          orchestrator.getEvidence(currentProj.id),
        ]);
        if (!isCurrentRequest() || !selectionUnchanged()) return;
        setTasks(taskList);
        setEvents(eventList);
        setEvidence(evidenceList);
      } else {
        setTasks([]);
        setEvents([]);
        setEvidence([]);
      }

      // Load real DB-backed agents and resources.
      const [resList, agentList] = await Promise.all([
        orchestrator.getProviderResources(),
        orchestrator.getAgents(),
      ]);
      if (!isCurrentRequest() || !selectionUnchanged()) return;
      setResources(resList);
      setAgents(agentList);
    } catch (err) {
      if (isCurrentRequest()) {
        const message = err instanceof Error ? err.message : 'Unable to refresh desktop data.';
        setRefreshError(message);
        console.error('[OrchestratorContext] Error refreshing data:', err);
      }
    } finally {
      if (isCurrentRequest()) {
        refreshInFlightRef.current = false;
        setLoading(false);
        if (refreshPendingRef.current) {
          refreshPendingRef.current = false;
          void refreshData();
        }
      }
    }
  }, []);

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 3000);
    return () => clearInterval(interval);
  }, [refreshData]);

  const runUiAction = async <T,>(name: UiActionName, invoke: () => Promise<unknown>, payloadField?: 'project' | 'task', accept?: (data: T) => void): Promise<UiActionResult<T>> => {
    const result = await actionRunnerRef.current!.run<T>(name, invoke, payloadField, async (data) => {
      accept?.(data);
      await refreshData();
    });
    if (result.success || result.code !== 'ACTION_PENDING') setActionResults((previous) => ({ ...previous, [name]: result }));
    return result;
  };

  const noProject = (name: UiActionName) => {
    const result = uiActionFailure(orchestrator ? 'NO_PROJECT' : 'DESKTOP_REQUIRED');
    setActionResults((previous) => ({ ...previous, [name]: result }));
    return result;
  };

  const createProject = async (data: { name: string; description?: string; repositorySelectionId: string; defaultBranch?: string }) => {
    return runUiAction<Project>('createProject', () => orchestrator.createProject(data), 'project', (project) => {
      activeProjectRef.current = project;
      setActiveProject(project);
    });
  };

  const importContract = async (contract: any) => {
    const project = activeProjectRef.current;
    if (!project) return noProject('importContract');
    return runUiAction<void>('importContract', () => orchestrator.importContract({ projectId: project.id, contract }));
  };

  const transitionProject = async (trigger: string) => {
    const project = activeProjectRef.current;
    if (!project) return noProject('projectTransition');
    return runUiAction<void>('projectTransition', () => orchestrator.transitionProject({ projectId: project.id, trigger }));
  };

  const createTask = async (spec: { title: string; description?: string | null; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; acceptanceCriteria?: string[]; constraints?: string[] }) => {
    const project = activeProjectRef.current;
    if (!project) return noProject('createTask');
    return runUiAction<Task>('createTask', () => orchestrator.createTask({
      projectId: project.id,
      title: spec.title,
      description: spec.description,
      priority: spec.priority || 'MEDIUM',
      risk: spec.risk || 'MEDIUM',
      acceptanceCriteria: spec.acceptanceCriteria || [],
      constraints: spec.constraints || [],
    }), 'task');
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
    if (!orchestrator) throw new Error('Desktop IPC unavailable.');
    const result = await orchestrator.updateResourceQuota({ id, remaining, total, source, confidence });
    if (
      result === false ||
      (result && typeof result === 'object' && 'success' in result && result.success === false)
    ) {
      const message = result && typeof result === 'object' && 'error' in result
        ? String(result.error || 'Failed to save quota snapshot.')
        : 'Failed to save quota snapshot.';
      throw new Error(message);
    }
    await refreshData();
  };

  const triggerEmergencyStop = async (reason?: string) => {
    if (!orchestrator) return;
    const res = await orchestrator.triggerEmergencyStop(reason);
    await refreshData();
    return res;
  };

  const resumeProject = async () => {
    const project = activeProjectRef.current;
    if (!project) return noProject('projectTransition');
    return runUiAction<void>('projectTransition', () => orchestrator.resumeProject(project.id));
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
    executionMode: RendererAuthorizationMode;
    assignmentId?: string;
    taskOwnershipEpoch?: number;
    contextManifestId?: string;
    executionScope?: CanonicalExecutionScope;
  }) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const res = await orchestrator.authorizeRoutedTask(data);
    await refreshData();
    return res;
  };

  const dispatchAuthorization = async (authorizationId: string, executionMode: RendererAuthorizationMode) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const res = await orchestrator.dispatchAuthorization(authorizationId, executionMode);
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

  const getVerificationCommands = async (projectId: string) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    return orchestrator.getVerificationCommands(projectId);
  };

  const saveVerificationCommands = async (data: {
    projectId: string;
    commands: {
      TEST?: string | null;
      LINT?: string | null;
      BUILD?: string | null;
    };
  }) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    return orchestrator.saveVerificationCommands(data);
  };

  const listQuarantinedSubmissions = async (options?: {
    projectId?: string;
    taskId?: string;
    limit?: number;
    offset?: number;
    reverse?: boolean;
  }) => {
    if (!orchestrator) return { success: false, items: [], total: 0 };
    return orchestrator.listQuarantinedSubmissions(options);
  };

  const inspectQuarantinedSubmission = async (submissionId: string) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    return orchestrator.inspectQuarantinedSubmission({ submissionId });
  };

  const admitQuarantinedSubmission = async (submissionId: string, expectedLifecycleVersion?: number) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const requestId = crypto.randomUUID();
    const res = await orchestrator.admitQuarantinedSubmission({ requestId, submissionId, expectedLifecycleVersion });
    await refreshData();
    return res;
  };

  const rejectQuarantinedSubmission = async (submissionId: string, expectedLifecycleVersion: number, reason: string) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const requestId = crypto.randomUUID();
    const res = await orchestrator.rejectQuarantinedSubmission({ requestId, submissionId, expectedLifecycleVersion, reason });
    await refreshData();
    return res;
  };

  const supersedeQuarantinedSubmission = async (
    submissionId: string,
    expectedLifecycleVersion: number,
    replacementSubmissionId: string,
    reason: string
  ) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const requestId = crypto.randomUUID();
    const res = await orchestrator.supersedeQuarantinedSubmission({
      requestId,
      submissionId,
      expectedLifecycleVersion,
      replacementSubmissionId,
      reason,
    });
    await refreshData();
    return res;
  };

  const resumeAdmittedSubmission = async (
    submissionId: string,
    adjudicationId: string,
    expectedLifecycleVersion: number
  ) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const requestId = crypto.randomUUID();
    const res = await orchestrator.resumeAdmittedSubmission({
      requestId,
      submissionId,
      adjudicationId,
      expectedLifecycleVersion,
    });
    await refreshData();
    return res;
  };

  const acknowledgeRecoveryFencedSubmission = async (
    submissionId: string,
    adjudicationId: string,
    expectedLifecycleVersion: number,
    decision: 'ACKNOWLEDGE' | 'CANCEL' = 'ACKNOWLEDGE'
  ) => {
    if (!orchestrator) return { success: false, error: 'Desktop required.' };
    const requestId = crypto.randomUUID();
    const res = await orchestrator.acknowledgeRecoveryFencedSubmission({
      requestId,
      submissionId,
      adjudicationId,
      expectedLifecycleVersion,
      decision,
    });
    await refreshData();
    return res;
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
        refreshError,
        pendingActions,
        actionResults,
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
        getVerificationCommands,
        saveVerificationCommands,
        listQuarantinedSubmissions,
        inspectQuarantinedSubmission,
        admitQuarantinedSubmission,
        rejectQuarantinedSubmission,
        supersedeQuarantinedSubmission,
        resumeAdmittedSubmission,
        acknowledgeRecoveryFencedSubmission,
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
