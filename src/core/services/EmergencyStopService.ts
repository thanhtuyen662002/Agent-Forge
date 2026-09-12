import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProcessRunner } from './ProcessRunner';
import { TaskStateMachine } from '../state/taskStateMachine';
import { ProjectStateMachine } from '../state/projectStateMachine';

export interface EmergencyStopResult {
  processesTerminated: number;
  tasksPaused: string[];
  projectsPaused: string[];
  timestamp: string;
  unprovenProcesses?: number;
  allTerminatedProven?: boolean;
}

export class EmergencyStopService {
  constructor(
    private repo: Repository,
    private eventService: EventService
  ) {}

  public triggerEmergencyStop(
    reason: string = 'Owner Emergency Stop Triggered'
  ): Promise<EmergencyStopResult> & EmergencyStopResult {
    const now = new Date().toISOString();

    // 1. Terminate all running child processes immediately and await truthfully
    const termPromise = ProcessRunner.terminateAllProcesses();

    // 2. Pause all active running projects
    const allProjects = this.repo.getAllProjects();
    const projectsPaused: string[] = [];

    for (const proj of allProjects) {
      if (proj.status === 'RUNNING' && ProjectStateMachine.canTransition(proj.status, 'PAUSE')) {
        const nextStatus = ProjectStateMachine.transition(proj.status, 'PAUSE');
        this.repo.updateProjectStatus(proj.id, nextStatus);
        projectsPaused.push(proj.id);
      }
    }

    // 3. Pause all active tasks in progress
    const tasksPaused: string[] = [];
    for (const proj of allProjects) {
      const tasks = this.repo.getTasksByProject(proj.id);
      for (const t of tasks) {
        if (['DISPATCHED', 'CODING', 'VALIDATING', 'REVIEWING'].includes(t.state)) {
          const transitionRes = TaskStateMachine.transition(t.state, 'PAUSE');
          this.repo.updateTaskState(t.id, transitionRes.nextState, transitionRes.pausedFromState);
          tasksPaused.push(t.id);

          this.eventService.record(
            proj.id,
            'TASK_PAUSED',
            `Task ${t.id} paused due to Emergency Stop (was in ${transitionRes.pausedFromState}).`,
            { taskId: t.id, pausedFrom: transitionRes.pausedFromState },
            t.id
          );
        }
      }
    }

    const syncResult: EmergencyStopResult = {
      processesTerminated: 0,
      tasksPaused,
      projectsPaused,
      timestamp: now,
      unprovenProcesses: 0,
      allTerminatedProven: true,
    };

    const recordEmergencyStopEvent = (summary: { count: number; unproven: number; allTerminatedProven: boolean }) => {
      const provenTerminated = summary.allTerminatedProven ? summary.count : Math.max(0, summary.count - summary.unproven);
      for (const projId of projectsPaused) {
        const proj = this.repo.getProject(projId);
        this.eventService.record(
          projId,
          'EMERGENCY_STOP',
          `Emergency stop triggered for project: ${proj ? proj.name : projId}. Reason: ${reason}`,
          {
            reason,
            processesTerminated: provenTerminated,
            unprovenProcesses: summary.unproven,
            allTerminatedProven: summary.allTerminatedProven,
          }
        );
      }
    };

    // If there are no processes running, record project event immediately
    if (ProcessRunner.getActiveProcessCount() === 0) {
      recordEmergencyStopEvent({ count: 0, unproven: 0, allTerminatedProven: true });
    }

    const asyncPromise = (async (): Promise<EmergencyStopResult> => {
      const summary = await termPromise;
      const provenTerminated = summary.allTerminatedProven ? summary.count : Math.max(0, summary.count - summary.unproven);
      syncResult.processesTerminated = provenTerminated;
      syncResult.unprovenProcesses = summary.unproven;
      syncResult.allTerminatedProven = summary.allTerminatedProven;

      if (summary.count > 0 || summary.unproven > 0) {
        recordEmergencyStopEvent(summary);
      }

      return syncResult;
    })();

    return Object.assign(asyncPromise, syncResult);
  }

  public resumeProject(projectId: string): boolean {
    const project = this.repo.getProject(projectId);
    if (!project || project.status !== 'PAUSED') return false;

    // 1. Resume project status
    const nextStatus = ProjectStateMachine.transition('PAUSED', 'RESUME');
    this.repo.updateProjectStatus(projectId, nextStatus);

    // 2. Resume paused tasks
    const tasks = this.repo.getTasksByProject(projectId);
    for (const t of tasks) {
      if (t.state === 'PAUSED') {
        const transitionRes = TaskStateMachine.transition('PAUSED', 'RESUME', {
          pausedFromState: t.paused_from_state,
        });
        this.repo.updateTaskState(t.id, transitionRes.nextState, null);
      }
    }

    this.eventService.record(
      projectId,
      'PROJECT_RESUMED',
      `Project ${project.name} resumed from PAUSED state.`
    );

    return true;
  }
}
