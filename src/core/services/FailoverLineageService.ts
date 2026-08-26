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

    const taskId = attempt.task_id;
    const visitedAttemptIds = new Set<string>();
    const visitedTransitionIds = new Set<string>();
    const transitions: FailoverTransition[] = [];
    let currentAttemptId = attemptId;

    // Walk backwards along successor -> transition -> source with cycle detection
    while (true) {
      if (visitedAttemptIds.has(currentAttemptId)) {
        throw new Error(
          `[FailoverLineageIntegrity] Cycle detected in failover lineage traversal at attempt "${currentAttemptId}".`
        );
      }
      visitedAttemptIds.add(currentAttemptId);

      const incomingTransition = this.repo.getFailoverTransitionBySuccessor(currentAttemptId);
      if (!incomingTransition) {
        break;
      }

      if (visitedTransitionIds.has(incomingTransition.id)) {
        throw new Error(
          `[FailoverLineageIntegrity] Cycle detected in failover transition chain at transition "${incomingTransition.id}".`
        );
      }
      visitedTransitionIds.add(incomingTransition.id);

      // Validate individual transition attributes against task
      if (
        incomingTransition.successor_attempt_id !== currentAttemptId ||
        incomingTransition.task_id !== taskId ||
        incomingTransition.failover_ordinal < 1
      ) {
        throw new Error(
          `[FailoverLineageIntegrity] Malformed transition "${incomingTransition.id}": task, successor, or ordinal mismatch.`
        );
      }

      const incomingSource = this.repo.getTaskAttempt(incomingTransition.source_attempt_id);
      if (!incomingSource || incomingSource.task_id !== taskId) {
        throw new Error(
          `[FailoverLineageIntegrity] Malformed transition "${incomingTransition.id}": source attempt "${incomingTransition.source_attempt_id}" missing or task mismatch.`
        );
      }

      const incomingRoot = this.repo.getTaskAttempt(incomingTransition.root_attempt_id);
      if (!incomingRoot || incomingRoot.task_id !== taskId) {
        throw new Error(
          `[FailoverLineageIntegrity] Malformed transition "${incomingTransition.id}": root attempt "${incomingTransition.root_attempt_id}" missing or task mismatch.`
        );
      }

      transitions.push(incomingTransition);
      currentAttemptId = incomingTransition.source_attempt_id;
    }

    if (transitions.length === 0) {
      return {
        currentAttemptId: attemptId,
        rootAttemptId: attemptId,
        failoverAttemptsUsed: 0,
        transitions: [],
      };
    }

    // Reverse to obtain chronological order: root -> current (T_1, T_2, ..., T_N)
    transitions.reverse();

    // Validate root stability across chain
    const rootAttemptId = transitions[0].root_attempt_id;
    for (const t of transitions) {
      if (t.root_attempt_id !== rootAttemptId) {
        throw new Error(
          `[FailoverLineageIntegrity] Root mismatch in lineage chain: expected "${rootAttemptId}", found "${t.root_attempt_id}".`
        );
      }
    }

    // Validate chain links: T_1.source == root, and T_{i-1}.successor == T_i.source
    if (transitions[0].source_attempt_id !== rootAttemptId) {
      throw new Error(
        `[FailoverLineageIntegrity] Broken chain start: initial transition "${transitions[0].id}" source "${transitions[0].source_attempt_id}" does not match root "${rootAttemptId}".`
      );
    }

    for (let i = 1; i < transitions.length; i++) {
      if (transitions[i - 1].successor_attempt_id !== transitions[i].source_attempt_id) {
        throw new Error(
          `[FailoverLineageIntegrity] Broken chain link between transition "${transitions[i - 1].id}" and "${transitions[i].id}".`
        );
      }
    }

    // Validate ordinal sequence: exactly 1, 2, 3, ..., N
    for (let i = 0; i < transitions.length; i++) {
      const expectedOrdinal = i + 1;
      if (transitions[i].failover_ordinal !== expectedOrdinal) {
        throw new Error(
          `[FailoverLineageIntegrity] Ordinal gap or sequence violation in transition "${transitions[i].id}": expected ordinal ${expectedOrdinal}, found ${transitions[i].failover_ordinal}.`
        );
      }
    }

    const failoverAttemptsUsed = transitions[transitions.length - 1].failover_ordinal;

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
