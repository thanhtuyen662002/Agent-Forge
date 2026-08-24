import crypto from 'crypto';
import {
  Capability,
  ProviderHealthStatus,
  ProviderAdapterType,
  FabricRole,
  RoleProfile,
  ProviderAccount,
  ProviderResource,
  AgentAssignment,
  SeparationPolicy,
  RoutePolicy,
  SeparationAffinity,
  QuotaSource,
} from '../types/domain';
import { Repository } from '../database/repositories';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { EventService } from './EventService';
import { QuotaSnapshotInfo } from '../adapters/ProviderAdapter';

export interface CandidateAccountResourceRef {
  accountId: string;
  resourceId: string;
}

export interface RoleAwareRoutingRequest {
  projectId: string;
  taskId: string;
  attemptId?: string | null;
  roleProfileId: string;
  agentProfileId?: string | null;
  routePolicyId?: string | null;
  separationPolicyId?: string | null;
  reviewedAssignmentId?: string | null;
  candidateRefs?: CandidateAccountResourceRef[];
  allowManualBridge?: boolean;
  requiredProviderId?: string | null;
  requiredAccountId?: string | null;
  requiredResourceId?: string | null;
  preferredProviderId?: string | null;
  preferredAccountId?: string | null;
  preferredResourceId?: string | null;
  preferredMetadata?: Record<string, unknown> | null;
  persistAssignment?: boolean;
}

export type RoleAwareRoutingOutcome =
  | 'SELECTED'
  | 'MANUAL_HANDOFF_REQUIRED'
  | 'NO_ELIGIBLE_PROVIDER'
  | 'NEEDS_OWNER';

export type CandidateEligibility = 'ELIGIBLE' | 'INELIGIBLE' | 'AUTH_ERROR';

export interface RoleAwareCandidateEvaluation {
  candidateId: string;
  providerId: string;
  accountId: string;
  resourceId: string;
  modelName: string;
  accountLabel: string;
  enabled: boolean;
  health: ProviderHealthStatus;
  accountHealth: ProviderHealthStatus;
  requiredCapabilitiesSatisfied: boolean;
  quotaSnapshot: QuotaSnapshotInfo;
  eligibility: CandidateEligibility;
  rejectionReasons: string[];
  preferenceScore: number;
  preferenceDetails: Record<string, number>;
  tier?: 1 | 2 | 3;
}

export interface AppliedSeparationAudit {
  separationPolicyId: string | null;
  separationPolicyName: string | null;
  reviewedAssignmentId: string | null;
  reviewedExecutionId: string | null;
  sameExecutionForbidden: boolean;
  sameSessionForbidden: boolean;
  sameAccountPolicy: SeparationAffinity;
  sameProviderPolicy: SeparationAffinity;
  sameModelPolicy: SeparationAffinity;
}

export interface RequestedRoutingConstraintsAudit {
  requiredProviderId: string | null;
  requiredAccountId: string | null;
  requiredResourceId: string | null;
  preferredProviderId: string | null;
  preferredAccountId: string | null;
  preferredResourceId: string | null;
}

export interface RoleAwareRoutingDecision {
  decisionId: string;
  projectId: string;
  taskId: string;
  attemptId: string | null;
  roleProfileId: string;
  role: FabricRole;
  agentProfileId: string | null;
  routePolicyId: string | null;
  outcome: RoleAwareRoutingOutcome;
  selectedResourceId: string | null;
  selectedAccountId: string | null;
  selectedProviderId: string | null;
  selectedAssignmentId: string | null;
  adapterType: ProviderAdapterType | null;
  candidateEvaluations: RoleAwareCandidateEvaluation[];
  requestedConstraints: RequestedRoutingConstraintsAudit;
  appliedSeparation: AppliedSeparationAudit | null;
  reason: string;
  createdAt: string;
}

export class RoleAwareRoutingService {
  constructor(
    private repo: Repository,
    private providerRegistry: ProviderRegistry,
    private eventService?: EventService
  ) {}

  /**
   * Deterministically evaluates candidate (ProviderAccount, ProviderResource) pairs
   * against RoleProfile requirements, explicit RoutePolicy, and SeparationPolicy.
   *
   * Pipeline order:
   * 1. ELIGIBILITY (Provider/Account/Resource health, capabilities, quotas, AUTH_ERROR check)
   * 2. REQUIRED_POLICY (Explicit required provider/account/resource filters)
   * 3. SEPARATION_VALIDATION (Hard separation: same_execution, different_account/provider/model required)
   * 4. PREFERENCE_SCORING (Deterministic preference scoring for diversity & preferences)
   * 5. DETERMINISTIC_SELECTION (Tie-breaking by stable IDs)
   * 6. ASSIGNMENT_BINDING (Creates/returns AgentAssignment)
   * 7. AUDIT (Emits durable structured event)
   */
  public async routeRole(request: RoleAwareRoutingRequest): Promise<RoleAwareRoutingDecision> {
    const decisionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const normalizedAttemptId = request.attemptId ?? null;

    const requestedConstraints: RequestedRoutingConstraintsAudit = {
      requiredProviderId: request.requiredProviderId ?? null,
      requiredAccountId: request.requiredAccountId ?? null,
      requiredResourceId: request.requiredResourceId ?? null,
      preferredProviderId: request.preferredProviderId ?? null,
      preferredAccountId: request.preferredAccountId ?? null,
      preferredResourceId: request.preferredResourceId ?? null,
    };

    // 1. Validate Scope: Project & Task
    const project = this.repo.getProject(request.projectId);
    if (!project) {
      return this.failClosed(
        decisionId,
        request,
        'NO_ELIGIBLE_PROVIDER',
        `Project "${request.projectId}" not found in database.`,
        requestedConstraints,
        null,
        createdAt
      );
    }

    const task = this.repo.getTask(request.taskId);
    if (!task) {
      return this.failClosed(
        decisionId,
        request,
        'NO_ELIGIBLE_PROVIDER',
        `Task "${request.taskId}" not found in database.`,
        requestedConstraints,
        null,
        createdAt
      );
    }

    if (task.project_id !== request.projectId) {
      return this.failClosed(
        decisionId,
        request,
        'NO_ELIGIBLE_PROVIDER',
        `Task "${request.taskId}" does not belong to project "${request.projectId}".`,
        requestedConstraints,
        null,
        createdAt
      );
    }

    if (request.attemptId) {
      const attempt = this.repo.getTaskAttempt(request.attemptId);
      if (!attempt || attempt.task_id !== request.taskId) {
        return this.failClosed(
          decisionId,
          request,
          'NO_ELIGIBLE_PROVIDER',
          `TaskAttempt "${request.attemptId}" not found or does not belong to task "${request.taskId}".`,
          requestedConstraints,
          null,
          createdAt
        );
      }
    }

    // 2. Validate RoleProfile
    const roleProfile = this.repo.getRoleProfile(request.roleProfileId);
    if (!roleProfile) {
      return this.failClosed(
        decisionId,
        request,
        'NO_ELIGIBLE_PROVIDER',
        `RoleProfile "${request.roleProfileId}" not found in database.`,
        requestedConstraints,
        null,
        createdAt
      );
    }

    if (!roleProfile.enabled) {
      return this.failClosed(
        decisionId,
        request,
        'NO_ELIGIBLE_PROVIDER',
        `RoleProfile "${request.roleProfileId}" is disabled.`,
        requestedConstraints,
        null,
        createdAt
      );
    }

    // 3. Load RoutePolicy & SeparationPolicy if specified
    let routePolicy: RoutePolicy | null = null;
    if (request.routePolicyId) {
      routePolicy = this.repo.getRoutePolicy(request.routePolicyId);
      if (!routePolicy) {
        return this.failClosed(
          decisionId,
          request,
          'NO_ELIGIBLE_PROVIDER',
          `RoutePolicy "${request.routePolicyId}" not found in database.`,
          requestedConstraints,
          null,
          createdAt
        );
      }
      if (!routePolicy.enabled) {
        return this.failClosed(
          decisionId,
          request,
          'NO_ELIGIBLE_PROVIDER',
          `RoutePolicy "${request.routePolicyId}" is disabled.`,
          requestedConstraints,
          null,
          createdAt
        );
      }
    }

    let separationPolicy: SeparationPolicy | null = null;
    if (request.separationPolicyId) {
      separationPolicy = this.repo.getSeparationPolicy(request.separationPolicyId);
      if (!separationPolicy) {
        return this.failClosed(
          decisionId,
          request,
          'NO_ELIGIBLE_PROVIDER',
          `SeparationPolicy "${request.separationPolicyId}" not found in database.`,
          requestedConstraints,
          null,
          createdAt
        );
      }
    }

    // Load reviewed prior assignment if provided
    let reviewedAssignment: AgentAssignment | null = null;
    if (request.reviewedAssignmentId) {
      reviewedAssignment = this.repo.getAgentAssignment(request.reviewedAssignmentId);
      if (!reviewedAssignment) {
        return this.failClosed(
          decisionId,
          request,
          'NO_ELIGIBLE_PROVIDER',
          `Reviewed AgentAssignment "${request.reviewedAssignmentId}" not found in database.`,
          requestedConstraints,
          null,
          createdAt
        );
      }
    }

    const appliedSeparation: AppliedSeparationAudit | null = separationPolicy
      ? {
          separationPolicyId: separationPolicy.id,
          separationPolicyName: separationPolicy.name,
          reviewedAssignmentId: reviewedAssignment ? reviewedAssignment.id : null,
          reviewedExecutionId: reviewedAssignment ? reviewedAssignment.attempt_id : null,
          sameExecutionForbidden: separationPolicy.same_execution_forbidden,
          sameSessionForbidden: separationPolicy.same_session_forbidden,
          sameAccountPolicy: separationPolicy.same_account_policy,
          sameProviderPolicy: separationPolicy.same_provider_policy,
          sameModelPolicy: separationPolicy.same_model_policy,
        }
      : null;

    // 4. Assemble Candidate Pool: (ProviderAccount, ProviderResource) pairs
    const candidatePairs: CandidateAccountResourceRef[] = [];
    if (request.candidateRefs && request.candidateRefs.length > 0) {
      const seen = new Set<string>();
      for (const pair of request.candidateRefs) {
        const key = `${pair.accountId}:${pair.resourceId}`;
        if (seen.has(key)) {
          throw new Error(
            `Duplicate candidate reference in role routing request: "${key}". Candidate list must contain unique pairs.`
          );
        }
        seen.add(key);
        candidatePairs.push(pair);
      }
    } else {
      // Auto-discover candidate accounts and resources
      const accounts = this.repo.getAllProviderAccounts().filter((a) => a.enabled);
      const allResources = this.repo.getAllProviderResources().filter((r) => r.enabled);
      for (const account of accounts) {
        const resources = allResources.filter((r) => r.provider_id === account.provider_id);
        for (const resource of resources) {
          // If resource explicitly binds to a provider_account_id, check match
          if (resource.provider_account_id && resource.provider_account_id !== account.id) {
            continue;
          }
          candidatePairs.push({
            accountId: account.id,
            resourceId: resource.id,
          });
        }
      }
    }

    if (candidatePairs.length === 0) {
      return this.failClosed(
        decisionId,
        request,
        'NO_ELIGIBLE_PROVIDER',
        'No candidate provider accounts/resources available for routing.',
        requestedConstraints,
        appliedSeparation,
        createdAt
      );
    }

    // Combine required capabilities from RoleProfile and RoutePolicy
    const requiredCaps = Array.from(
      new Set([
        ...roleProfile.required_capabilities,
        ...(routePolicy ? routePolicy.required_capabilities : []),
      ])
    );

    const preferredCaps = Array.from(
      new Set([
        ...roleProfile.preferred_capabilities,
        ...(routePolicy ? routePolicy.preferred_capabilities : []),
      ])
    );

    const allowManualBridge =
      request.allowManualBridge ?? (routePolicy ? routePolicy.allow_manual_bridge : false);

    const candidateEvaluations: RoleAwareCandidateEvaluation[] = [];

    // 5. Evaluate Each Candidate Pair
    for (const pair of candidatePairs) {
      const candidateId = `${pair.accountId}:${pair.resourceId}`;
      const account = this.repo.getProviderAccount(pair.accountId);
      const resource = this.repo.getProviderResource(pair.resourceId);
      const rejectionReasons: string[] = [];

      if (!account) {
        candidateEvaluations.push({
          candidateId,
          providerId: 'UNKNOWN',
          accountId: pair.accountId,
          resourceId: pair.resourceId,
          modelName: 'UNKNOWN',
          accountLabel: 'UNKNOWN',
          enabled: false,
          health: 'UNKNOWN',
          accountHealth: 'UNKNOWN',
          requiredCapabilitiesSatisfied: false,
          quotaSnapshot: this.emptyQuota(),
          eligibility: 'INELIGIBLE',
          rejectionReasons: [`ProviderAccount "${pair.accountId}" not found in database.`],
          preferenceScore: 0,
          preferenceDetails: {},
        });
        continue;
      }

      if (!resource) {
        candidateEvaluations.push({
          candidateId,
          providerId: account.provider_id,
          accountId: pair.accountId,
          resourceId: pair.resourceId,
          modelName: 'UNKNOWN',
          accountLabel: account.label,
          enabled: false,
          health: 'UNKNOWN',
          accountHealth: account.health_status,
          requiredCapabilitiesSatisfied: false,
          quotaSnapshot: this.emptyQuota(),
          eligibility: 'INELIGIBLE',
          rejectionReasons: [`ProviderResource "${pair.resourceId}" not found in database.`],
          preferenceScore: 0,
          preferenceDetails: {},
        });
        continue;
      }

      // Check resource-to-provider alignment
      if (resource.provider_id !== account.provider_id) {
        rejectionReasons.push(
          `Resource provider "${resource.provider_id}" does not match account provider "${account.provider_id}".`
        );
      }

      // Check account enabled & health
      if (!account.enabled) {
        rejectionReasons.push(`ProviderAccount "${account.id}" is disabled.`);
      }
      if (
        account.health_status === 'DISABLED' ||
        account.health_status === 'OFFLINE' ||
        account.health_status === 'UNHEALTHY' ||
        account.health_status === 'QUOTA_EXHAUSTED'
      ) {
        rejectionReasons.push(
          `ProviderAccount "${account.id}" health status is "${account.health_status}".`
        );
      }

      // Check provider & resource enabled
      const provider = this.repo.getProvider(resource.provider_id);
      const adapter = this.providerRegistry.get(resource.provider_id);

      if (!resource.enabled) {
        rejectionReasons.push(`ProviderResource "${resource.id}" is disabled.`);
      }
      if (!provider) {
        rejectionReasons.push(`Parent Provider "${resource.provider_id}" not found in database.`);
      } else if (!provider.enabled) {
        rejectionReasons.push(`Parent Provider "${resource.provider_id}" is disabled.`);
      }
      if (!adapter) {
        rejectionReasons.push(
          `Provider adapter "${resource.provider_id}" is not registered in ProviderRegistry.`
        );
      }

      if (rejectionReasons.length > 0) {
        candidateEvaluations.push({
          candidateId,
          providerId: resource.provider_id,
          accountId: account.id,
          resourceId: resource.id,
          modelName: resource.model_name,
          accountLabel: account.label,
          enabled: account.enabled && resource.enabled,
          health: resource.health_status,
          accountHealth: account.health_status,
          requiredCapabilitiesSatisfied: false,
          quotaSnapshot: this.resourceQuota(resource),
          eligibility: 'INELIGIBLE',
          rejectionReasons,
          preferenceScore: 0,
          preferenceDetails: {},
        });
        continue;
      }

      const resolvedAdapter = adapter!;

      // Handle Manual Bridge candidate
      if (resolvedAdapter.adapterType === 'MANUAL_BRIDGE') {
        if (!allowManualBridge) {
          rejectionReasons.push(
            'Manual Bridge is not permitted by routing request or policy (allowManualBridge=false).'
          );
        }

        const missingCaps = requiredCaps.filter((c) => !resource.capabilities.includes(c));
        if (missingCaps.length > 0) {
          rejectionReasons.push(
            `Required capabilities [${missingCaps.join(', ')}] missing from Manual Bridge resource.`
          );
        }

        // Apply Hard Required Constraints
        this.checkRequiredConstraints(
          request,
          resource.provider_id,
          account.id,
          resource.id,
          rejectionReasons
        );

        // Apply Separation Policy (if any)
        if (separationPolicy && reviewedAssignment) {
          this.checkSeparationPolicy(
            separationPolicy,
            reviewedAssignment,
            request,
            account.id,
            resource.provider_id,
            resource.id,
            resource.model_name,
            rejectionReasons
          );
        }

        const isEligible = rejectionReasons.length === 0;
        const preferenceDetails: Record<string, number> = { baseTier: 100 };
        let preferenceScore = isEligible ? 100 : 0;

        candidateEvaluations.push({
          candidateId,
          providerId: resource.provider_id,
          accountId: account.id,
          resourceId: resource.id,
          modelName: resource.model_name,
          accountLabel: account.label,
          enabled: resource.enabled,
          health: resource.health_status,
          accountHealth: account.health_status,
          requiredCapabilitiesSatisfied: missingCaps.length === 0,
          quotaSnapshot: this.resourceQuota(resource),
          eligibility: isEligible ? 'ELIGIBLE' : 'INELIGIBLE',
          rejectionReasons,
          preferenceScore,
          preferenceDetails,
          tier: isEligible ? 3 : undefined,
        });
        continue;
      }

      // Probing Automated Adapter
      let liveHealth: ProviderHealthStatus = 'OFFLINE';
      let healthProbeError: string | null = null;
      try {
        liveHealth = await resolvedAdapter.getHealth();
      } catch (err: any) {
        liveHealth = 'OFFLINE';
        healthProbeError = `Health probe threw exception: ${err.message}`;
      }

      // AUTH_ERROR Hard-Stop: Halt routing immediately
      if (liveHealth === 'AUTH_ERROR' || account.health_status === 'AUTH_ERROR') {
        candidateEvaluations.push({
          candidateId,
          providerId: resource.provider_id,
          accountId: account.id,
          resourceId: resource.id,
          modelName: resource.model_name,
          accountLabel: account.label,
          enabled: resource.enabled,
          health: 'AUTH_ERROR',
          accountHealth: 'AUTH_ERROR',
          requiredCapabilitiesSatisfied: false,
          quotaSnapshot: this.resourceQuota(resource),
          eligibility: 'AUTH_ERROR',
          rejectionReasons: ['Provider or account returned AUTH_ERROR during health check.'],
          preferenceScore: 0,
          preferenceDetails: {},
        });

        const decision: RoleAwareRoutingDecision = {
          decisionId,
          projectId: request.projectId,
          taskId: request.taskId,
          attemptId: normalizedAttemptId,
          roleProfileId: roleProfile.id,
          role: roleProfile.role,
          agentProfileId: request.agentProfileId ?? null,
          routePolicyId: routePolicy ? routePolicy.id : null,
          outcome: 'NEEDS_OWNER',
          selectedResourceId: null,
          selectedAccountId: null,
          selectedProviderId: null,
          selectedAssignmentId: null,
          adapterType: null,
          candidateEvaluations,
          requestedConstraints,
          appliedSeparation,
          reason: `AUTH_ERROR on candidate "${candidateId}" (provider "${resource.provider_id}"). Routing halted to prevent silent authority bypass.`,
          createdAt,
        };
        this.recordDecisionEvent(request, decision);
        return decision;
      }

      // Quota Probe
      let liveQuota: QuotaSnapshotInfo = this.resourceQuota(resource);
      try {
        const probedQuota = await resolvedAdapter.getQuota();
        if (probedQuota.source !== 'UNKNOWN' || liveQuota.source === 'UNKNOWN') {
          liveQuota = probedQuota;
        }
      } catch (err: any) {
        if (!healthProbeError) {
          healthProbeError = `Quota probe threw exception: ${err.message}`;
        }
      }

      if (healthProbeError) {
        rejectionReasons.push(healthProbeError);
      }

      // Capabilities Probe
      let adapterCaps: Capability[] = [];
      try {
        adapterCaps = await resolvedAdapter.getCapabilities();
      } catch (err: any) {
        rejectionReasons.push(`CAPABILITY_PROBE_FAILED: ${err.message}`);
      }

      const missingResourceCaps = requiredCaps.filter((c) => !resource.capabilities.includes(c));
      const missingAdapterCaps = requiredCaps.filter((c) => !adapterCaps.includes(c));

      if (missingResourceCaps.length > 0 || missingAdapterCaps.length > 0) {
        const missing = Array.from(new Set([...missingResourceCaps, ...missingAdapterCaps]));
        rejectionReasons.push(
          `Required capabilities [${missing.join(', ')}] not satisfied by resource or adapter.`
        );
      }

      // Health & Quota Eligibility
      let candidateTier: 1 | 2 | undefined;
      if (liveHealth === 'AVAILABLE') {
        candidateTier = 1;
      } else if (liveHealth === 'LOW_QUOTA') {
        candidateTier = 2;
      } else {
        rejectionReasons.push(`Health status "${liveHealth}" is not eligible for automated dispatch.`);
      }

      if (liveHealth === 'QUOTA_EXHAUSTED') {
        rejectionReasons.push('Provider health status is QUOTA_EXHAUSTED.');
      } else if (
        liveQuota.remaining !== null &&
        liveQuota.remaining <= 0 &&
        ['MEASURED', 'PROVIDER_REPORTED', 'MANUAL'].includes(liveQuota.source)
      ) {
        rejectionReasons.push(
          `Authoritative quota exhausted (remaining: ${liveQuota.remaining}, source: ${liveQuota.source}).`
        );
      }

      // Apply Explicit Required Constraints
      this.checkRequiredConstraints(
        request,
        resource.provider_id,
        account.id,
        resource.id,
        rejectionReasons
      );

      // Apply Separation Policy
      if (separationPolicy && reviewedAssignment) {
        this.checkSeparationPolicy(
          separationPolicy,
          reviewedAssignment,
          request,
          account.id,
          resource.provider_id,
          resource.id,
          resource.model_name,
          rejectionReasons
        );
      }

      const isEligible = rejectionReasons.length === 0;

      // Calculate Preference Score
      const preferenceDetails: Record<string, number> = {};
      let preferenceScore = 0;

      if (isEligible) {
        const baseScore = candidateTier === 1 ? 1000 : 500;
        preferenceScore += baseScore;
        preferenceDetails.baseTier = baseScore;

        if (account.priority > 0) {
          const priorityScore = account.priority * 10;
          preferenceScore += priorityScore;
          preferenceDetails.accountPriority = priorityScore;
        }

        // Preferred capabilities matching
        const matchedPreferred = preferredCaps.filter(
          (c) => resource.capabilities.includes(c) && adapterCaps.includes(c)
        );
        if (matchedPreferred.length > 0) {
          const capScore = matchedPreferred.length * 50;
          preferenceScore += capScore;
          preferenceDetails.preferredCapabilities = capScore;
        }

        // Preferred provider/account/resource matching
        if (request.preferredProviderId && resource.provider_id === request.preferredProviderId) {
          preferenceScore += 100;
          preferenceDetails.preferredProviderMatch = 100;
        }
        if (request.preferredAccountId && account.id === request.preferredAccountId) {
          preferenceScore += 100;
          preferenceDetails.preferredAccountMatch = 100;
        }
        if (request.preferredResourceId && resource.id === request.preferredResourceId) {
          preferenceScore += 100;
          preferenceDetails.preferredResourceMatch = 100;
        }

        // Soft Diversity Preferences from SeparationPolicy
        if (separationPolicy && reviewedAssignment) {
          if (
            separationPolicy.same_account_policy === 'PREFER_DIFFERENT' &&
            account.id !== reviewedAssignment.selected_account_id
          ) {
            preferenceScore += 100;
            preferenceDetails.preferDifferentAccount = 100;
          }
          if (
            separationPolicy.same_provider_policy === 'PREFER_DIFFERENT' &&
            resource.provider_id !== reviewedAssignment.selected_provider_id
          ) {
            preferenceScore += 100;
            preferenceDetails.preferDifferentProvider = 100;
          }
          if (
            separationPolicy.same_model_policy === 'PREFER_DIFFERENT'
          ) {
            const reviewedResource = this.repo.getProviderResource(reviewedAssignment.selected_resource_id);
            const isDifferentModel =
              resource.id !== reviewedAssignment.selected_resource_id &&
              (!reviewedResource || resource.model_name !== reviewedResource.model_name);
            if (isDifferentModel) {
              preferenceScore += 100;
              preferenceDetails.preferDifferentModel = 100;
            }
          }
        }
      }

      candidateEvaluations.push({
        candidateId,
        providerId: resource.provider_id,
        accountId: account.id,
        resourceId: resource.id,
        modelName: resource.model_name,
        accountLabel: account.label,
        enabled: resource.enabled,
        health: liveHealth,
        accountHealth: account.health_status,
        requiredCapabilitiesSatisfied:
          missingResourceCaps.length === 0 && missingAdapterCaps.length === 0,
        quotaSnapshot: liveQuota,
        eligibility: isEligible ? 'ELIGIBLE' : 'INELIGIBLE',
        rejectionReasons,
        preferenceScore,
        preferenceDetails,
        tier: isEligible ? candidateTier : undefined,
      });
    }

    // 6. Deterministic Selection
    const eligibleCandidates = candidateEvaluations.filter((c) => c.eligibility === 'ELIGIBLE');

    if (eligibleCandidates.length === 0) {
      return this.failClosed(
        decisionId,
        request,
        'NO_ELIGIBLE_PROVIDER',
        'No eligible provider account/resource found satisfying all required capabilities, policy constraints, and separation rules.',
        requestedConstraints,
        appliedSeparation,
        createdAt,
        candidateEvaluations
      );
    }

    // Sort by preference score descending, tie-break by candidateId ascending lexicographically
    eligibleCandidates.sort((a, b) => {
      if (b.preferenceScore !== a.preferenceScore) {
        return b.preferenceScore - a.preferenceScore;
      }
      return a.candidateId.localeCompare(b.candidateId);
    });

    const winner = eligibleCandidates[0];
    const resolvedAdapter = this.providerRegistry.resolve(winner.providerId);

    // 7. Assignment Binding
    let selectedAssignmentId: string | null = null;
    if (request.persistAssignment) {
      const assignmentId = crypto.randomUUID();
      const assignment: AgentAssignment = {
        id: assignmentId,
        project_id: request.projectId,
        task_id: request.taskId,
        attempt_id: normalizedAttemptId,
        role_profile_id: roleProfile.id,
        agent_profile_id: request.agentProfileId ?? null,
        selected_provider_id: winner.providerId,
        selected_account_id: winner.accountId,
        selected_resource_id: winner.resourceId,
        selected_worker_slot_id: null,
        routing_decision_id: decisionId,
        preferred_metadata: request.preferredMetadata ?? null,
        status: 'ASSIGNED',
        created_at: createdAt,
        ended_at: null,
      };
      this.repo.createAgentAssignment(assignment);
      selectedAssignmentId = assignmentId;
    }

    const decision: RoleAwareRoutingDecision = {
      decisionId,
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: normalizedAttemptId,
      roleProfileId: roleProfile.id,
      role: roleProfile.role,
      agentProfileId: request.agentProfileId ?? null,
      routePolicyId: routePolicy ? routePolicy.id : null,
      outcome: winner.tier === 3 ? 'MANUAL_HANDOFF_REQUIRED' : 'SELECTED',
      selectedResourceId: winner.resourceId,
      selectedAccountId: winner.accountId,
      selectedProviderId: winner.providerId,
      selectedAssignmentId,
      adapterType: resolvedAdapter.adapterType,
      candidateEvaluations,
      requestedConstraints,
      appliedSeparation,
      reason: `Selected candidate account "${winner.accountId}" (${winner.accountLabel}) with resource "${winner.resourceId}" (model: "${winner.modelName}", score: ${winner.preferenceScore}).`,
      createdAt,
    };

    this.recordDecisionEvent(request, decision);
    return decision;
  }

  private checkRequiredConstraints(
    request: RoleAwareRoutingRequest,
    providerId: string,
    accountId: string,
    resourceId: string,
    rejectionReasons: string[]
  ): void {
    if (request.requiredProviderId && providerId !== request.requiredProviderId) {
      rejectionReasons.push(
        `REQUIRED_PROVIDER_MISMATCH: Candidate provider "${providerId}" does not match required provider "${request.requiredProviderId}".`
      );
    }
    if (request.requiredAccountId && accountId !== request.requiredAccountId) {
      rejectionReasons.push(
        `REQUIRED_ACCOUNT_MISMATCH: Candidate account "${accountId}" does not match required account "${request.requiredAccountId}".`
      );
    }
    if (request.requiredResourceId && resourceId !== request.requiredResourceId) {
      rejectionReasons.push(
        `REQUIRED_RESOURCE_MISMATCH: Candidate resource "${resourceId}" does not match required resource "${request.requiredResourceId}".`
      );
    }
  }

  private checkSeparationPolicy(
    policy: SeparationPolicy,
    reviewedAssignment: AgentAssignment,
    request: RoleAwareRoutingRequest,
    candidateAccountId: string,
    candidateProviderId: string,
    candidateResourceId: string,
    candidateModelName: string,
    rejectionReasons: string[]
  ): void {
    // 1. Same Execution Forbidden (Self-review prohibition)
    if (policy.same_execution_forbidden) {
      // Check if current attempt / assignment identity matches reviewed assignment
      if (
        (request.attemptId && reviewedAssignment.attempt_id && request.attemptId === reviewedAssignment.attempt_id) ||
        (request.reviewedAssignmentId && request.reviewedAssignmentId === reviewedAssignment.id && !request.attemptId)
      ) {
        rejectionReasons.push(
          `SAME_EXECUTION_FORBIDDEN: Self-review rejected. Reviewer cannot be dispatched under the same execution/attempt "${reviewedAssignment.attempt_id ?? reviewedAssignment.id}".`
        );
      }
    }

    // 2. Same Account Policy
    if (policy.same_account_policy === 'REQUIRE_DIFFERENT') {
      if (candidateAccountId === reviewedAssignment.selected_account_id) {
        rejectionReasons.push(
          `DIFFERENT_ACCOUNT_REQUIRED: Separation policy requires a different account from reviewed assignment account "${reviewedAssignment.selected_account_id}".`
        );
      }
    }

    // 3. Same Provider Policy
    if (policy.same_provider_policy === 'REQUIRE_DIFFERENT') {
      if (candidateProviderId === reviewedAssignment.selected_provider_id) {
        rejectionReasons.push(
          `DIFFERENT_PROVIDER_REQUIRED: Separation policy requires a different provider from reviewed assignment provider "${reviewedAssignment.selected_provider_id}".`
        );
      }
    }

    // 4. Same Model Policy
    if (policy.same_model_policy === 'REQUIRE_DIFFERENT') {
      const reviewedResource = this.repo.getProviderResource(reviewedAssignment.selected_resource_id);
      const isSameModel =
        candidateResourceId === reviewedAssignment.selected_resource_id ||
        (reviewedResource && candidateModelName === reviewedResource.model_name);
      if (isSameModel) {
        rejectionReasons.push(
          `DIFFERENT_MODEL_REQUIRED: Separation policy requires a different model from reviewed assignment model "${reviewedResource?.model_name ?? reviewedAssignment.selected_resource_id}".`
        );
      }
    }
  }

  private failClosed(
    decisionId: string,
    request: RoleAwareRoutingRequest,
    outcome: RoleAwareRoutingOutcome,
    reason: string,
    requestedConstraints: RequestedRoutingConstraintsAudit,
    appliedSeparation: AppliedSeparationAudit | null,
    createdAt: string,
    candidateEvaluations: RoleAwareCandidateEvaluation[] = []
  ): RoleAwareRoutingDecision {
    const roleProfile = this.repo.getRoleProfile(request.roleProfileId);
    const decision: RoleAwareRoutingDecision = {
      decisionId,
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: request.attemptId ?? null,
      roleProfileId: request.roleProfileId,
      role: roleProfile ? roleProfile.role : ('CODER' as FabricRole),
      agentProfileId: request.agentProfileId ?? null,
      routePolicyId: request.routePolicyId ?? null,
      outcome,
      selectedResourceId: null,
      selectedAccountId: null,
      selectedProviderId: null,
      selectedAssignmentId: null,
      adapterType: null,
      candidateEvaluations,
      requestedConstraints,
      appliedSeparation,
      reason,
      createdAt,
    };
    this.recordDecisionEvent(request, decision);
    return decision;
  }

  private emptyQuota(): QuotaSnapshotInfo {
    return {
      remaining: null,
      total: null,
      unit: 'UNKNOWN',
      source: 'UNKNOWN' as QuotaSource,
      confidence: 0.0,
      resetAt: null,
    };
  }

  private resourceQuota(resource: ProviderResource): QuotaSnapshotInfo {
    return {
      remaining: resource.remaining_quota,
      total: resource.total_quota,
      unit: resource.quota_unit,
      source: resource.quota_source,
      confidence: resource.quota_confidence,
      resetAt: resource.quota_reset_at,
    };
  }

  private recordDecisionEvent(
    request: RoleAwareRoutingRequest,
    decision: RoleAwareRoutingDecision
  ): void {
    if (!this.eventService) return;
    try {
      const project = this.repo.getProject(request.projectId);
      if (!project) return;
      const task = this.repo.getTask(request.taskId);
      const validTaskId = task && task.project_id === request.projectId ? request.taskId : null;

      this.eventService.record(
        request.projectId,
        'ROLE_AWARE_ROUTING_DECISION',
        `Role-aware routing decision: ${decision.outcome} for role ${decision.role} on task ${request.taskId} (${decision.reason})`,
        {
          decisionId: decision.decisionId,
          roleProfileId: decision.roleProfileId,
          role: decision.role,
          outcome: decision.outcome,
          selectedProviderId: decision.selectedProviderId,
          selectedAccountId: decision.selectedAccountId,
          selectedResourceId: decision.selectedResourceId,
          selectedAssignmentId: decision.selectedAssignmentId,
          requestedConstraints: decision.requestedConstraints,
          appliedSeparation: decision.appliedSeparation,
          reason: decision.reason,
        },
        validTaskId
      );
    } catch {
      // Non-blocking event logging
    }
  }
}
