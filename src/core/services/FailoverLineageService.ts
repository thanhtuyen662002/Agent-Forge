import { Repository } from '../database/repositories';
import {
  FailoverTransition,
  FailoverLineageContext,
  FailoverSuccessorClaimResult,
  ClaimSuccessorParams,
} from '../types/domain';

export class FailoverLineageService {
  constructor(private repo: Repository) {}

  /**
   * Atomically claims a whole-attempt failover successor for a failed source attempt.
   * Backed by Repository.runInImmediateTransaction and database-level unique constraints.
   *
   * Idempotent by sourceAttemptId: repeated calls return the existing transition and successor.
   *
   * @param params Claim parameters including transitionId, sourceAttemptId, and successorAttemptId
   * @returns FailoverSuccessorClaimResult with status 'CREATED', 'ALREADY_CLAIMED', or failure status
   */
  public claimSuccessor(params: ClaimSuccessorParams): FailoverSuccessorClaimResult {
    return this.repo.claimSuccessorTaskAttempt(params);
  }

  /**
   * Reconstructs the failover lineage context and calculates authoritative failoverAttemptsUsed
   * for a given task attempt.
   *
   * - An attempt with no predecessor transitions has failoverAttemptsUsed = 0.
   * - An attempt produced by transition ordinal N has failoverAttemptsUsed = N.
   * - Transitions array is ordered deterministically by failover_ordinal ASC.
   *
   * @param attemptId The task attempt ID to inspect
   * @returns FailoverLineageContext containing currentAttemptId, rootAttemptId, failoverAttemptsUsed, and transitions
   */
  public getLineageContext(attemptId: string): FailoverLineageContext {
    if (
      typeof attemptId !== 'string' ||
      attemptId.trim().length === 0 ||
      attemptId !== attemptId.trim()
    ) {
      throw new Error(
        '[FailoverLineageService] attemptId must be a non-empty string without surrounding whitespace.'
      );
    }

    const attempt = this.repo.getTaskAttempt(attemptId);
    if (!attempt) {
      throw new Error(
        `[FailoverLineageService] TaskAttempt "${attemptId}" not found.`
      );
    }

    const transitions: FailoverTransition[] = [];
    let currentAttemptId = attemptId;
    let rootAttemptId = attemptId;

    // Walk backwards along successor -> transition -> source
    while (true) {
      const incomingTransition = this.repo.getFailoverTransitionBySuccessor(currentAttemptId);
      if (!incomingTransition) {
        break;
      }
      transitions.push(incomingTransition);
      rootAttemptId = incomingTransition.root_attempt_id;
      currentAttemptId = incomingTransition.source_attempt_id;
    }

    // Reverse to obtain ordered lineage: [T_1, ..., T_current] (failover_ordinal ASC)
    transitions.reverse();

    const failoverAttemptsUsed =
      transitions.length > 0 ? transitions[transitions.length - 1].failover_ordinal : 0;

    return {
      currentAttemptId: attemptId,
      rootAttemptId,
      failoverAttemptsUsed,
      transitions,
    };
  }

  public getTransitionsByRoot(rootAttemptId: string): FailoverTransition[] {
    if (
      typeof rootAttemptId !== 'string' ||
      rootAttemptId.trim().length === 0 ||
      rootAttemptId !== rootAttemptId.trim()
    ) {
      throw new Error(
        '[FailoverLineageService] rootAttemptId must be a non-empty string without surrounding whitespace.'
      );
    }
    return this.repo.getFailoverTransitionsByRoot(rootAttemptId);
  }

  public getTransitionsByTask(taskId: string): FailoverTransition[] {
    if (
      typeof taskId !== 'string' ||
      taskId.trim().length === 0 ||
      taskId !== taskId.trim()
    ) {
      throw new Error(
        '[FailoverLineageService] taskId must be a non-empty string without surrounding whitespace.'
      );
    }
    return this.repo.getFailoverTransitionsByTask(taskId);
  }

  public getTransitionBySource(sourceAttemptId: string): FailoverTransition | null {
    if (
      typeof sourceAttemptId !== 'string' ||
      sourceAttemptId.trim().length === 0 ||
      sourceAttemptId !== sourceAttemptId.trim()
    ) {
      throw new Error(
        '[FailoverLineageService] sourceAttemptId must be a non-empty string without surrounding whitespace.'
      );
    }
    return this.repo.getFailoverTransitionBySource(sourceAttemptId);
  }

  public getTransitionBySuccessor(successorAttemptId: string): FailoverTransition | null {
    if (
      typeof successorAttemptId !== 'string' ||
      successorAttemptId.trim().length === 0 ||
      successorAttemptId !== successorAttemptId.trim()
    ) {
      throw new Error(
        '[FailoverLineageService] successorAttemptId must be a non-empty string without surrounding whitespace.'
      );
    }
    return this.repo.getFailoverTransitionBySuccessor(successorAttemptId);
  }
}
