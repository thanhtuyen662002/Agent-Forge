import {
  AgentAssignment,
  EvaluateFailoverNextRouteParams,
  FailoverNextRoutePlan,
  FailoverRouteStage,
} from '../types/domain';

function sortUnique(arr: string[]): string[] {
  const unique = Array.from(new Set(arr.filter((s) => typeof s === 'string' && s.length > 0)));
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique;
}

export class FailoverNextRoutePolicyService {
  /**
   * Deterministically evaluates the failover policy, decision, lineage context,
   * and assignment history to produce an ordered list of routing stages.
   *
   * Pure, side-effect free, clock-free, and database-free.
   */
  public static evaluate(params: EvaluateFailoverNextRouteParams): FailoverNextRoutePlan {
    if (!params || typeof params !== 'object') {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: 0,
        stages: [],
        reason: 'INVALID_INPUT: params must be a non-null object.',
      };
    }

    const { policyResult, decision, lineage, assignments } = params;

    // 1. Policy parse result validation
    if (!policyResult || typeof policyResult !== 'object' || !('status' in policyResult)) {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: 0,
        stages: [],
        reason: 'INVALID_INPUT: policyResult must be provided.',
      };
    }

    if (policyResult.status === 'INVALID') {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: 0,
        stages: [],
        reason: `INVALID_INPUT: policy parse status is INVALID: ${policyResult.error}`,
      };
    }

    if (policyResult.status === 'ABSENT') {
      return {
        outcome: 'FAILOVER_NOT_AUTHORIZED',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: 0,
        stages: [],
        reason: 'FAILOVER_NOT_AUTHORIZED: Failover policy is absent.',
      };
    }

    if (policyResult.status === 'DISABLED' as any) {
      return {
        outcome: 'FAILOVER_NOT_AUTHORIZED',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: 0,
        stages: [],
        reason: 'FAILOVER_NOT_AUTHORIZED: Failover policy is disabled.',
      };
    }

    if (policyResult.status !== 'VALID' || !policyResult.policy) {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: 0,
        stages: [],
        reason: `INVALID_INPUT: Unexpected policy parse status "${(policyResult as any).status}".`,
      };
    }

    const policy = policyResult.policy;
    if (!policy.enabled) {
      return {
        outcome: 'FAILOVER_NOT_AUTHORIZED',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: 0,
        stages: [],
        reason: 'FAILOVER_NOT_AUTHORIZED: Failover policy is disabled.',
      };
    }

    // 2. Decision authority validation
    if (!decision || typeof decision !== 'object' || !('outcome' in decision)) {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: policy.same_account_retries,
        stages: [],
        reason: 'INVALID_INPUT: decision must be provided.',
      };
    }

    if (decision.outcome !== 'FAILOVER_ALLOWED') {
      return {
        outcome: 'FAILOVER_NOT_AUTHORIZED',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: policy.same_account_retries,
        stages: [],
        reason: `FAILOVER_NOT_AUTHORIZED: Decision outcome is "${decision.outcome}" (reason: ${decision.reason}).`,
      };
    }

    // 3. Lineage structural validation
    if (
      !lineage ||
      typeof lineage !== 'object' ||
      typeof lineage.currentAttemptId !== 'string' ||
      typeof lineage.rootAttemptId !== 'string' ||
      typeof lineage.failoverAttemptsUsed !== 'number' ||
      !Array.isArray(lineage.transitions)
    ) {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: lineage?.currentAttemptId ?? '',
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: policy.same_account_retries,
        stages: [],
        reason: 'INVALID_INPUT: Malformed lineage context.',
      };
    }

    let orderedAttemptIds: string[];

    if (lineage.transitions.length === 0) {
      if (lineage.rootAttemptId !== lineage.currentAttemptId || lineage.failoverAttemptsUsed !== 0) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: null,
          currentProviderId: null,
          currentAccountId: null,
          currentResourceId: null,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: 'INVALID_INPUT: Zero-transition lineage must have rootAttemptId equal to currentAttemptId and failoverAttemptsUsed equal to 0.',
        };
      }
      orderedAttemptIds = [lineage.currentAttemptId];
    } else {
      if (lineage.transitions[0].source_attempt_id !== lineage.rootAttemptId) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: null,
          currentProviderId: null,
          currentAccountId: null,
          currentResourceId: null,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Initial transition source "${lineage.transitions[0].source_attempt_id}" does not match rootAttemptId "${lineage.rootAttemptId}".`,
        };
      }

      for (const t of lineage.transitions) {
        if (t.root_attempt_id !== lineage.rootAttemptId) {
          return {
            outcome: 'INVALID_INPUT',
            currentAttemptId: lineage.currentAttemptId,
            currentAssignmentId: null,
            currentProviderId: null,
            currentAccountId: null,
            currentResourceId: null,
            consecutiveSameAccountRetriesUsed: 0,
            sameAccountRetriesAllowed: policy.same_account_retries,
            stages: [],
            reason: `INVALID_INPUT: Transition "${t.id}" root "${t.root_attempt_id}" does not match rootAttemptId "${lineage.rootAttemptId}".`,
          };
        }
      }

      for (let i = 1; i < lineage.transitions.length; i++) {
        if (lineage.transitions[i - 1].successor_attempt_id !== lineage.transitions[i].source_attempt_id) {
          return {
            outcome: 'INVALID_INPUT',
            currentAttemptId: lineage.currentAttemptId,
            currentAssignmentId: null,
            currentProviderId: null,
            currentAccountId: null,
            currentResourceId: null,
            consecutiveSameAccountRetriesUsed: 0,
            sameAccountRetriesAllowed: policy.same_account_retries,
            stages: [],
            reason: `INVALID_INPUT: Broken link between transition "${lineage.transitions[i - 1].id}" and "${lineage.transitions[i].id}".`,
          };
        }
      }

      for (let i = 0; i < lineage.transitions.length; i++) {
        if (lineage.transitions[i].failover_ordinal !== i + 1) {
          return {
            outcome: 'INVALID_INPUT',
            currentAttemptId: lineage.currentAttemptId,
            currentAssignmentId: null,
            currentProviderId: null,
            currentAccountId: null,
            currentResourceId: null,
            consecutiveSameAccountRetriesUsed: 0,
            sameAccountRetriesAllowed: policy.same_account_retries,
            stages: [],
            reason: `INVALID_INPUT: Ordinal gap at transition "${lineage.transitions[i].id}": expected ${i + 1}, got ${lineage.transitions[i].failover_ordinal}.`,
          };
        }
      }

      const lastTransition = lineage.transitions[lineage.transitions.length - 1];
      if (lastTransition.successor_attempt_id !== lineage.currentAttemptId) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: null,
          currentProviderId: null,
          currentAccountId: null,
          currentResourceId: null,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Last transition successor "${lastTransition.successor_attempt_id}" does not match currentAttemptId "${lineage.currentAttemptId}".`,
        };
      }

      if (lineage.failoverAttemptsUsed !== lineage.transitions.length) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: null,
          currentProviderId: null,
          currentAccountId: null,
          currentResourceId: null,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: failoverAttemptsUsed (${lineage.failoverAttemptsUsed}) does not match transition count (${lineage.transitions.length}).`,
        };
      }

      orderedAttemptIds = [
        lineage.rootAttemptId,
        ...lineage.transitions.map((t) => t.successor_attempt_id),
      ];
    }

    // 4. Max Failover Budget Consistency check
    if (lineage.failoverAttemptsUsed >= policy.max_failover_attempts) {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: lineage.currentAttemptId,
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: policy.same_account_retries,
        stages: [],
        reason: `INVALID_INPUT: Decision / lineage / policy budget inconsistency: failoverAttemptsUsed (${lineage.failoverAttemptsUsed}) >= max_failover_attempts (${policy.max_failover_attempts}).`,
      };
    }

    // 5. Assignment history binding
    if (!Array.isArray(assignments)) {
      return {
        outcome: 'INVALID_INPUT',
        currentAttemptId: lineage.currentAttemptId,
        currentAssignmentId: null,
        currentProviderId: null,
        currentAccountId: null,
        currentResourceId: null,
        consecutiveSameAccountRetriesUsed: 0,
        sameAccountRetriesAllowed: policy.same_account_retries,
        stages: [],
        reason: 'INVALID_INPUT: assignments must be an array.',
      };
    }

    const orderedAssignments: AgentAssignment[] = [];
    for (const attemptId of orderedAttemptIds) {
      const matches = assignments.filter((a) => a && a.attempt_id === attemptId);
      if (matches.length === 0) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: null,
          currentProviderId: null,
          currentAccountId: null,
          currentResourceId: null,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Missing AgentAssignment for lineage attempt "${attemptId}".`,
        };
      }
      if (matches.length > 1) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: null,
          currentProviderId: null,
          currentAccountId: null,
          currentResourceId: null,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Duplicate AgentAssignment for lineage attempt "${attemptId}" (${matches.length} found).`,
        };
      }
      orderedAssignments.push(matches[0]);
    }

    // 6. Validate assignment chain consistency (same project, task, role profile, agent profile)
    const currentAssignment = orderedAssignments[orderedAssignments.length - 1];
    for (const a of orderedAssignments) {
      if (a.project_id !== currentAssignment.project_id) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: currentAssignment.id,
          currentProviderId: currentAssignment.selected_provider_id,
          currentAccountId: currentAssignment.selected_account_id,
          currentResourceId: currentAssignment.selected_resource_id,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Cross-project assignment history detected in lineage: "${a.project_id}" !== "${currentAssignment.project_id}".`,
        };
      }
      if (a.task_id !== currentAssignment.task_id) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: currentAssignment.id,
          currentProviderId: currentAssignment.selected_provider_id,
          currentAccountId: currentAssignment.selected_account_id,
          currentResourceId: currentAssignment.selected_resource_id,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Cross-task assignment history detected in lineage: "${a.task_id}" !== "${currentAssignment.task_id}".`,
        };
      }
      if (a.role_profile_id !== currentAssignment.role_profile_id) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: currentAssignment.id,
          currentProviderId: currentAssignment.selected_provider_id,
          currentAccountId: currentAssignment.selected_account_id,
          currentResourceId: currentAssignment.selected_resource_id,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Cross-role assignment history detected in lineage: "${a.role_profile_id}" !== "${currentAssignment.role_profile_id}".`,
        };
      }
      if (a.agent_profile_id !== currentAssignment.agent_profile_id) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: currentAssignment.id,
          currentProviderId: currentAssignment.selected_provider_id,
          currentAccountId: currentAssignment.selected_account_id,
          currentResourceId: currentAssignment.selected_resource_id,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Cross-agent-profile assignment history detected in lineage: "${a.agent_profile_id}" !== "${currentAssignment.agent_profile_id}".`,
        };
      }
      if (!a.selected_provider_id || !a.selected_account_id) {
        return {
          outcome: 'INVALID_INPUT',
          currentAttemptId: lineage.currentAttemptId,
          currentAssignmentId: currentAssignment.id,
          currentProviderId: currentAssignment.selected_provider_id,
          currentAccountId: currentAssignment.selected_account_id,
          currentResourceId: currentAssignment.selected_resource_id,
          consecutiveSameAccountRetriesUsed: 0,
          sameAccountRetriesAllowed: policy.same_account_retries,
          stages: [],
          reason: `INVALID_INPUT: Assignment "${a.id}" missing selected_provider_id or selected_account_id.`,
        };
      }
    }

    const currentProviderId = currentAssignment.selected_provider_id;
    const currentAccountId = currentAssignment.selected_account_id;
    const currentResourceId = currentAssignment.selected_resource_id;

    // 7. Calculate consecutive same-account retries used
    let consecutiveSameAccountRetriesUsed = 0;
    if (orderedAssignments.length > 1) {
      for (let i = orderedAssignments.length - 1; i >= 1; i--) {
        if (orderedAssignments[i - 1].selected_account_id === currentAccountId) {
          consecutiveSameAccountRetriesUsed++;
        } else {
          break;
        }
      }
    }

    // 8. Track used candidates, accounts, and providers in lineage history
    const usedCandidatesInLineage: string[] = [];
    const usedAccountsInLineage: string[] = [];
    const usedProvidersInLineage: string[] = [];
    const usedCandidatesInCurrentProvider: string[] = [];
    const usedAccountsInCurrentProvider: string[] = [];

    for (const a of orderedAssignments) {
      if (a.selected_provider_id) {
        usedProvidersInLineage.push(a.selected_provider_id);
      }
      if (a.selected_account_id) {
        usedAccountsInLineage.push(a.selected_account_id);
        if (a.selected_resource_id) {
          usedCandidatesInLineage.push(`${a.selected_account_id}:${a.selected_resource_id}`);
        }
        if (a.selected_provider_id === currentProviderId) {
          usedAccountsInCurrentProvider.push(a.selected_account_id);
          if (a.selected_resource_id) {
            usedCandidatesInCurrentProvider.push(`${a.selected_account_id}:${a.selected_resource_id}`);
          }
        }
      }
    }

    // 9. Generate ordered routing stages
    const stages: FailoverRouteStage[] = [];

    // Stage 1: SAME_ACCOUNT_RETRY
    if (
      policy.same_account_retries > 0 &&
      consecutiveSameAccountRetriesUsed < policy.same_account_retries
    ) {
      stages.push({
        kind: 'SAME_ACCOUNT_RETRY',
        requiredProviderId: currentProviderId,
        requiredAccountId: currentAccountId,
        requiredResourceId: null,
        excludedCandidateIds: [],
        excludedAccountIds: [],
        excludedProviderIds: [],
        reason: `Retry with the current account under same provider (same-account retry ${consecutiveSameAccountRetriesUsed + 1}/${policy.same_account_retries}).`,
      });
    }

    // Stage 2: CROSS_ACCOUNT_SAME_PROVIDER
    if (policy.allow_cross_account) {
      stages.push({
        kind: 'CROSS_ACCOUNT_SAME_PROVIDER',
        requiredProviderId: currentProviderId,
        requiredAccountId: null,
        requiredResourceId: null,
        excludedCandidateIds: sortUnique(usedCandidatesInCurrentProvider),
        excludedAccountIds: sortUnique(usedAccountsInCurrentProvider),
        excludedProviderIds: [],
        reason: 'Failover to an alternate account under the same provider.',
      });
    }

    // Stage 3: CROSS_PROVIDER
    if (policy.allow_cross_provider) {
      stages.push({
        kind: 'CROSS_PROVIDER',
        requiredProviderId: null,
        requiredAccountId: null,
        requiredResourceId: null,
        excludedCandidateIds: sortUnique(usedCandidatesInLineage),
        excludedAccountIds: sortUnique(usedAccountsInLineage),
        excludedProviderIds: sortUnique(usedProvidersInLineage),
        reason: 'Failover to an alternate provider.',
      });
    }

    const outcome = stages.length > 0 ? 'ROUTE_STAGES_READY' : 'NO_ROUTE_SCOPE_ALLOWED';
    const reason =
      stages.length > 0
        ? `Generated ${stages.length} routing stage(s) based on failover policy.`
        : 'No routing scope allowed: same-account retry budget exhausted and cross-account / cross-provider failover disallowed by policy.';

    return {
      outcome,
      currentAttemptId: lineage.currentAttemptId,
      currentAssignmentId: currentAssignment.id,
      currentProviderId,
      currentAccountId,
      currentResourceId,
      consecutiveSameAccountRetriesUsed,
      sameAccountRetriesAllowed: policy.same_account_retries,
      stages,
      reason,
    };
  }
}
