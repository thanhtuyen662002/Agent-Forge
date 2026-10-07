import type { Repository } from '../../src/core/database/repositories';
import { VerificationCapabilityService } from '../../src/core/services/VerificationCapabilityService';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CanonicalExecutionPayload, computePayloadHash } from '../../src/core/services/ExecutionAuthorizationService';

/** Explicit backend owner confirmation for isolated test projects only. */
export async function approveFixtureCommand(repo: Repository, projectId: string, args: string[], executable = process.execPath) {
  const project = repo.getProject(projectId);
  if (!project) throw new Error('FIXTURE_PROJECT_MISSING');
  const service = new VerificationCapabilityService(repo);
  const proposal = service.propose(projectId, executable, args, project.repository_path);
  const capability = await service.approve(proposal, async () => true);
  return { executable: proposal.executable.path, args: [...proposal.args], capability };
}

/** A real approved test script inside the fixture repository's ignored directory. */
export async function approveFixtureScript(repo: Repository, projectId: string, source: string) {
  const project = repo.getProject(projectId);
  if (!project) throw new Error('FIXTURE_PROJECT_MISSING');
  const directory = path.join(project.repository_path, 'temp-artifacts');
  fs.mkdirSync(directory, { recursive: true });
  const script = path.join(directory, `verification-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(script, source, 'utf8');
  return approveFixtureCommand(repo, projectId, [script]);
}

/** Freeze an explicitly approved fixture command before observing its result. */
export function freezeFixtureVerificationCommand(repo: Repository, authorizationId: string,
  command: NonNullable<CanonicalExecutionPayload['verificationCommands']['TEST']>) {
  const authorization = repo.getExecutionAuthorization(authorizationId);
  if (!authorization?.canonical_payload_json) throw new Error('FIXTURE_AUTHORIZATION_MISSING');
  const payload = JSON.parse(authorization.canonical_payload_json) as CanonicalExecutionPayload;
  payload.verificationCommands.TEST = command;
  repo.getDatabase().prepare('UPDATE execution_authorizations SET canonical_payload_json=?, instruction_payload_hash=? WHERE id=?')
    .run(JSON.stringify(payload), computePayloadHash(payload), authorizationId);
  return payload.verificationCommands;
}
