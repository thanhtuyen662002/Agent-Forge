import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventRecord } from '../types/domain';

export class EventService {
  constructor(private repo: Repository) {}

  public record(
    projectId: string,
    type: string,
    summary: string,
    structuredPayload: Record<string, unknown> = {},
    taskId: string | null = null,
    agentId: string | null = null
  ): EventRecord {
    const event: EventRecord = {
      id: crypto.randomUUID(),
      project_id: projectId,
      task_id: taskId,
      agent_id: agentId,
      type,
      summary,
      structured_payload: structuredPayload,
      timestamp: new Date().toISOString(),
    };

    this.repo.createEvent(event);
    return event;
  }

  public getEvents(projectId?: string, limit: number = 100): EventRecord[] {
    return this.repo.getEvents(projectId, limit);
  }
}
