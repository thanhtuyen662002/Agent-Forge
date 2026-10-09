import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProcessRunner } from './ProcessRunner';
import { TaskStateMachine } from '../state/taskStateMachine';
import { ProjectStateMachine } from '../state/projectStateMachine';
import { ProjectStopFenceService, sanitizeProjectStopReason } from './ProjectStopFenceService';

export interface EmergencyStopResult {
  processesTerminated: number;
  tasksPaused: string[];
  projectsPaused: string[];
  timestamp: string;
  unprovenProcesses: number;
  allTerminatedProven: boolean;
  stopEpochs: Record<string, number>;
}

export class EmergencyStopService {
  private readonly stopFence: ProjectStopFenceService;

  constructor(
    private repo: Repository,
    private eventService: EventService
  ) {
    this.stopFence = new ProjectStopFenceService(repo);
  }

  public async triggerEmergencyStop(
    reason: string = 'Owner Emergency Stop Triggered',
    expectedEpochByProject?: Readonly<Record<string, number>>
  ): Promise<EmergencyStopResult> {
    const now = new Date().toISOString();
    const safeReason = sanitizeProjectStopReason(reason);

    // 1. Establish the durable admission fence before touching a process. A
    //    process kill is best-effort; the SQLite latch is the safety boundary.
    const fence = this.stopFence.requestStopForAllProjects(safeReason, expectedEpochByProject, now);

    // 2. Terminate all running child processes and preserve uncertainty when
    //    the termination observer itself fails.
    let summary: { count: number; unproven: number; allTerminatedProven: boolean };
    try {
      summary = await ProcessRunner.terminateAllProcesses();
    } catch {
      const count = ProcessRunner.getActiveProcessCount();
      summary = { count, unproven: count, allTerminatedProven: false };
    }
    const provenTerminated = summary.allTerminatedProven
      ? summary.count
      : Math.max(0, summary.count - summary.unproven);

    // 3. Complete the audit record after termination truth is known. The
    //    request event was committed in the same transaction as the latch;
    //    this completion event carries the sanitized uncertainty evidence.
    const affectedProjectIds = fence.projectIds;
    for (const projId of affectedProjectIds) {
      const mutation = fence.projects.find((item) => item.projectId === projId);
      const proj = this.repo.getProjectMetadata(projId);
      this.eventService.record(
        projId,
        'EMERGENCY_STOP',
        `Emergency stop triggered for project: ${proj ? proj.name : projId}. Reason: ${safeReason}`,
        {
          reason: safeReason,
          stopEpoch: mutation?.epoch,
          stopFenceStatus: mutation?.status,
          processesTerminated: provenTerminated,
          unprovenProcesses: summary.unproven,
          allTerminatedProven: summary.allTerminatedProven,
        }
      );
    }

    return {
      processesTerminated: provenTerminated,
      tasksPaused: fence.tasksPaused,
      projectsPaused: fence.projects
        .filter((mutation) => mutation.status === 'STOPPED' && this.repo.getProjectMetadata(mutation.projectId)?.status === 'PAUSED')
        .map((mutation) => mutation.projectId),
      timestamp: now,
      unprovenProcesses: summary.unproven,
      allTerminatedProven: summary.allTerminatedProven,
      stopEpochs: Object.fromEntries(
        fence.projects
          .filter((mutation) => mutation.epoch !== null)
          .map((mutation) => [mutation.projectId, mutation.epoch as number])
      ),
    };
  }

  public resumeProject(projectId: string, expectedEpoch?: number): boolean {
    const result = this.stopFence.resumeProject(projectId, expectedEpoch);
    // Preserve the historical boolean API for an ordinary RUNNING project
    // while treating a repeated resume of a previously emergency-stopped
    // epoch as the idempotent success it is.
    return result.status === 'RESUMED' || (result.status === 'ALREADY_RESUMED' && (result.previousEpoch ?? 0) > 0);
  }

  public getStopFence(projectId: string) {
    return this.stopFence.getFence(projectId);
  }
}
