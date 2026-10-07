import type { Repository } from '../../src/core/database/repositories';
import { VerificationCapabilityService } from '../../src/core/services/VerificationCapabilityService';

/** Explicit backend owner confirmation for isolated test projects only. */
export async function approveFixtureCommand(repo: Repository, projectId: string, args: string[], executable = process.execPath) {
  const project = repo.getProject(projectId);
  if (!project) throw new Error('FIXTURE_PROJECT_MISSING');
  const service = new VerificationCapabilityService(repo);
  const proposal = service.propose(projectId, executable, args, project.repository_path);
  const capability = await service.approve(proposal, async () => true);
  return { executable: proposal.executable.path, args: [...proposal.args], capability };
}
