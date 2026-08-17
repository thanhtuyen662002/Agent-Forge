import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProjectStateMachine, ProjectTrigger } from '../state/projectStateMachine';
import { Project, ProjectContract, ProjectStatus } from '../types/domain';

export class ProjectService {
  constructor(
    private repo: Repository,
    private eventService: EventService
  ) {}

  public createProject(name: string, description: string, repositoryPath: string, defaultBranch: string = 'main'): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: `PROJ-${crypto.randomUUID().substring(0, 8).toUpperCase()}`,
      name,
      description,
      repository_path: repositoryPath,
      default_branch: defaultBranch,
      status: 'DRAFT',
      contract: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
    };

    this.repo.createProject(project);
    this.eventService.record(project.id, 'PROJECT_CREATED', `Project "${name}" initialized in DRAFT state.`);
    return project;
  }

  public importContract(projectId: string, contract: ProjectContract): boolean {
    const project = this.repo.getProject(projectId);
    if (!project) return false;

    this.repo.updateProjectContract(projectId, contract);
    if (project.status === 'DRAFT' && ProjectStateMachine.canTransition(project.status, 'IMPORT_CONTRACT')) {
      const nextStatus = ProjectStateMachine.transition(project.status, 'IMPORT_CONTRACT');
      this.repo.updateProjectStatus(projectId, nextStatus);
    }

    this.eventService.record(
      projectId,
      'CONTRACT_IMPORTED',
      `Project contract imported for project "${project.name}". Goal: ${contract.goal}`
    );

    return true;
  }

  public transitionStatus(projectId: string, trigger: ProjectTrigger): ProjectStatus {
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);

    const nextStatus = ProjectStateMachine.transition(project.status, trigger);
    const startedAt = trigger === 'START_PROJECT' ? new Date().toISOString() : undefined;
    const completedAt = trigger === 'FINAL_PASS' ? new Date().toISOString() : undefined;

    this.repo.updateProjectStatus(projectId, nextStatus, startedAt, completedAt);
    this.eventService.record(
      projectId,
      'PROJECT_STATUS_CHANGED',
      `Project ${project.name} transitioned from ${project.status} to ${nextStatus} via ${trigger}.`
    );

    return nextStatus;
  }
}
