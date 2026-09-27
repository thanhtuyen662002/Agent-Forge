import { Repository } from '../database/repositories';
import {
  ProviderHealthObservationApplicationResult,
} from '../types/domain';
import {
  AccountHealthService,
  ProviderHealthObservationReplayReport,
} from './AccountHealthService';

/**
 * Narrow runtime facade for the single provider-account health writer.
 * Dispatch and startup recovery depend on these functions rather than
 * constructing the writer themselves, which keeps the ownership boundary
 * auditable and makes accidental direct health mutation easy to detect.
 */
export function applyProviderHealthObservation(
  repo: Repository,
  authorizationId: string,
): ProviderHealthObservationApplicationResult {
  return AccountHealthService.create(repo).applyObservation(authorizationId);
}

export function replayProviderHealthObservations(
  repo: Repository,
): ProviderHealthObservationReplayReport {
  return AccountHealthService.create(repo).replayProviderHealthObservations();
}
