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
}

export class EmergencyStopService {
  constructor(
    private repo: Repository,
    private eventService: EventService
  ) {}

  public triggerEmergencyStop(reason: string = 'Owner Emergency Stop Triggered'): EmergencyStopResult {
    const now = new Date().toISOString();

    // 1. Terminate all running child processes immediately
    const processesTerminated = ProcessRunner.terminateAllProcesses();

    // 2. Pause all active running projects
    const allProjects = this.repo.getAllProjects();
    const projectsPaused: string[] = [];

    for (const proj of allProjects) {
      if (proj.status === 'RUNNING' && ProjectStateMachine.canTransition(proj.status, 'PAUSE')) {
        const nextStatus = ProjectStateMachine.transition(proj.status, 'PAUSE');
        this.repo.updateProjectStatus(proj.id, nextStatus);
        projectsPaused.push(proj.id);

        this.eventService.record(
          proj.id,
          'EMERGENCY_STOP',
          `Emergency stop triggered for project: ${proj.name}. Reason: ${reason}`,
          { reason, processesTerminated }
        );
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

    return {
      processesTerminated,
      tasksPaused,
      projectsPaused,
      timestamp: now,
    };
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
