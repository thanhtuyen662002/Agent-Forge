import crypto from 'crypto';
import {
  Capability,
  ProviderHealthStatus,
  ProviderAdapterType,
} from '../types/domain';
import { Repository } from '../database/repositories';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { EventService } from './EventService';
import { QuotaSnapshotInfo } from '../adapters/ProviderAdapter';

export interface RoutingRequest {
  projectId: string;
  taskId: string;
  attemptId?: string | null;
  requiredCapabilities: Capability[];
  candidateResourceIds: string[];
  allowManualBridge: boolean;
}

export type RoutingOutcome =
  | 'SELECTED'
  | 'MANUAL_HANDOFF_REQUIRED'
  | 'NO_ELIGIBLE_PROVIDER'
  | 'NEEDS_OWNER';

export type CandidateEligibility = 'ELIGIBLE' | 'INELIGIBLE' | 'AUTH_ERROR';

export interface CandidateEvaluation {
  resourceId: string;
  providerId: string;
  modelName: string;
  enabled: boolean;
  health: ProviderHealthStatus;
  requiredCapabilitiesSatisfied: boolean;
  quotaSnapshot: QuotaSnapshotInfo;
  eligibility: CandidateEligibility;
  rejectionReasons: string[];
  tier?: 1 | 2 | 3; // 1: AVAILABLE automated, 2: LOW_QUOTA automated, 3: MANUAL_BRIDGE
}

export interface RoutingDecision {
  decisionId: string;
  outcome: RoutingOutcome;
  selectedResourceId: string | null;
  selectedProviderId: string | null;
  adapterType: ProviderAdapterType | null;
  candidateEvaluations: CandidateEvaluation[];
  reason: string;
  createdAt: string;
}

export class ProviderRoutingService {
  constructor(
    private repo: Repository,
    private providerRegistry: ProviderRegistry,
    private eventService?: EventService
  ) {}

  /**
   * Evaluates candidate provider resources deterministically before execution dispatch.
   * Auto failover is pre-dispatch only.
   */
  public async route(request: RoutingRequest): Promise<RoutingDecision> {
    const decisionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // 1. Validate candidate list presence
    if (!request.candidateResourceIds || request.candidateResourceIds.length === 0) {
      const decision: RoutingDecision = {
        decisionId,
        outcome: 'NO_ELIGIBLE_PROVIDER',
        selectedResourceId: null,
        selectedProviderId: null,
        adapterType: null,
        candidateEvaluations: [],
        reason: 'No candidate resources provided in routing request.',
        createdAt,
      };
      this.recordDecisionEvent(request, decision);
      return decision;
    }

    // 2. Reject duplicate candidate IDs explicitly
    const seenCandidateIds = new Set<string>();
    for (const resId of request.candidateResourceIds) {
      if (seenCandidateIds.has(resId)) {
        throw new Error(
          `Duplicate candidate resource ID in routing request: "${resId}". Candidate list must contain unique IDs.`
        );
      }
      seenCandidateIds.add(resId);
    }

    const candidateEvaluations: CandidateEvaluation[] = [];

    // 3. Evaluate each candidate in explicit request order
    for (const resourceId of request.candidateResourceIds) {
      const resource = this.repo.getProviderResource(resourceId);

      if (!resource) {
        candidateEvaluations.push({
          resourceId,
          providerId: 'UNKNOWN',
          modelName: 'UNKNOWN',
          enabled: false,
          health: 'UNKNOWN',
          requiredCapabilitiesSatisfied: false,
          quotaSnapshot: {
            remaining: null,
            total: null,
            unit: 'UNKNOWN',
            source: 'UNKNOWN',
            confidence: 0.0,
            resetAt: null,
          },
          eligibility: 'INELIGIBLE',
          rejectionReasons: [`ProviderResource "${resourceId}" not found in database.`],
        });
        continue;
      }

      const provider = this.repo.getProvider(resource.provider_id);
      const adapter = this.providerRegistry.get(resource.provider_id);
      const rejectionReasons: string[] = [];

      // Check durable enabled flags
      if (!resource.enabled) {
        rejectionReasons.push(`ProviderResource "${resourceId}" is disabled.`);
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

      // If configuration gates fail, reject without probing
      if (rejectionReasons.length > 0) {
        candidateEvaluations.push({
          resourceId,
          providerId: resource.provider_id,
          modelName: resource.model_name,
          enabled: resource.enabled,
          health: resource.health_status,
          requiredCapabilitiesSatisfied: false,
          quotaSnapshot: {
            remaining: resource.remaining_quota,
            total: resource.total_quota,
            unit: resource.quota_unit,
            source: resource.quota_source,
            confidence: resource.quota_confidence,
            resetAt: resource.quota_reset_at,
          },
          eligibility: 'INELIGIBLE',
          rejectionReasons,
        });
        continue;
      }

      // Safe non-null assertion since checked above
      const resolvedAdapter = adapter!;

      // 4. Handle Manual Bridge candidate
      if (resolvedAdapter.adapterType === 'MANUAL_BRIDGE') {
        if (!request.allowManualBridge) {
          rejectionReasons.push(
            'Manual Bridge is not permitted by routing request (allowManualBridge=false).'
          );
        }

        // Validate required capabilities against resource capabilities
        const missingCaps = request.requiredCapabilities.filter(
          (c) => !resource.capabilities.includes(c)
        );
        if (missingCaps.length > 0) {
          rejectionReasons.push(
            `Required capabilities [${missingCaps.join(', ')}] missing from Manual Bridge resource capabilities.`
          );
        }

        const isEligible = rejectionReasons.length === 0;
        candidateEvaluations.push({
          resourceId,
          providerId: resource.provider_id,
          modelName: resource.model_name,
          enabled: resource.enabled,
          health: resource.health_status,
          requiredCapabilitiesSatisfied: missingCaps.length === 0,
          quotaSnapshot: {
            remaining: resource.remaining_quota,
            total: resource.total_quota,
            unit: resource.quota_unit,
            source: resource.quota_source,
            confidence: resource.quota_confidence,
            resetAt: resource.quota_reset_at,
          },
          eligibility: isEligible ? 'ELIGIBLE' : 'INELIGIBLE',
          rejectionReasons,
          tier: isEligible ? 3 : undefined,
        });
        continue;
      }

      // 5. Handle Automated Adapter candidate
      let liveHealth: ProviderHealthStatus = 'OFFLINE';
      let healthProbeError: string | null = null;
      try {
        liveHealth = await resolvedAdapter.getHealth();
      } catch (err: any) {
        liveHealth = 'OFFLINE';
        healthProbeError = `Health probe threw exception: ${err.message}`;
      }

      // AUTH_ERROR Hard-Stop Check: Halt routing immediately to prevent silent credential bypass
      if (liveHealth === 'AUTH_ERROR') {
        candidateEvaluations.push({
          resourceId,
          providerId: resource.provider_id,
          modelName: resource.model_name,
          enabled: resource.enabled,
          health: 'AUTH_ERROR',
          requiredCapabilitiesSatisfied: false,
          quotaSnapshot: {
            remaining: resource.remaining_quota,
            total: resource.total_quota,
            unit: resource.quota_unit,
            source: resource.quota_source,
            confidence: resource.quota_confidence,
            resetAt: resource.quota_reset_at,
          },
          eligibility: 'AUTH_ERROR',
          rejectionReasons: ['Provider returned AUTH_ERROR during health probe.'],
        });

        const decision: RoutingDecision = {
          decisionId,
          outcome: 'NEEDS_OWNER',
          selectedResourceId: null,
          selectedProviderId: null,
          adapterType: null,
          candidateEvaluations,
          reason: `AUTH_ERROR on candidate "${resourceId}" (provider "${resource.provider_id}"). Routing halted to prevent silent authority bypass.`,
          createdAt,
        };
        this.recordDecisionEvent(request, decision);
        return decision;
      }

      // Probe Quota Telemetry
      let liveQuota: QuotaSnapshotInfo = {
        remaining: resource.remaining_quota,
        total: resource.total_quota,
        unit: resource.quota_unit,
        source: resource.quota_source,
        confidence: resource.quota_confidence,
        resetAt: resource.quota_reset_at,
      };
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

      // Check Capabilities: Subset of BOTH resource.capabilities and adapter.getCapabilities()
      let adapterCaps: Capability[] = [];
      try {
        adapterCaps = await resolvedAdapter.getCapabilities();
      } catch {
        adapterCaps = [];
      }

      const missingResourceCaps = request.requiredCapabilities.filter(
        (c) => !resource.capabilities.includes(c)
      );
      const missingAdapterCaps = request.requiredCapabilities.filter(
        (c) => !adapterCaps.includes(c)
      );

      if (missingResourceCaps.length > 0 || missingAdapterCaps.length > 0) {
        const missing = Array.from(new Set([...missingResourceCaps, ...missingAdapterCaps]));
        rejectionReasons.push(
          `Required capabilities [${missing.join(', ')}] not satisfied by resource or adapter.`
        );
      }

      // Check Automated Health Eligibility
      let candidateTier: 1 | 2 | undefined;
      if (liveHealth === 'AVAILABLE') {
        candidateTier = 1;
      } else if (liveHealth === 'LOW_QUOTA') {
        candidateTier = 2;
      } else {
        rejectionReasons.push(
          `Health status "${liveHealth}" is not eligible for automated dispatch.`
        );
      }

      // Check Authoritative Quota Exhaustion
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

      const isEligible = rejectionReasons.length === 0;
      candidateEvaluations.push({
        resourceId,
        providerId: resource.provider_id,
        modelName: resource.model_name,
        enabled: resource.enabled,
        health: liveHealth,
        requiredCapabilitiesSatisfied:
          missingResourceCaps.length === 0 && missingAdapterCaps.length === 0,
        quotaSnapshot: liveQuota,
        eligibility: isEligible ? 'ELIGIBLE' : 'INELIGIBLE',
        rejectionReasons,
        tier: isEligible ? candidateTier : undefined,
      });
    }

    // 6. Deterministic Selection
    // Tier 1: First AVAILABLE automated candidate
    const tier1Candidate = candidateEvaluations.find(
      (c) => c.eligibility === 'ELIGIBLE' && c.tier === 1
    );
    if (tier1Candidate) {
      const adapter = this.providerRegistry.resolve(tier1Candidate.providerId);
      const decision: RoutingDecision = {
        decisionId,
        outcome: 'SELECTED',
        selectedResourceId: tier1Candidate.resourceId,
        selectedProviderId: tier1Candidate.providerId,
        adapterType: adapter.adapterType,
        candidateEvaluations,
        reason: `Selected AVAILABLE provider resource "${tier1Candidate.resourceId}" (model: "${tier1Candidate.modelName}").`,
        createdAt,
      };
      this.recordDecisionEvent(request, decision);
      return decision;
    }

    // Tier 2: First LOW_QUOTA automated candidate
    const tier2Candidate = candidateEvaluations.find(
      (c) => c.eligibility === 'ELIGIBLE' && c.tier === 2
    );
    if (tier2Candidate) {
      const adapter = this.providerRegistry.resolve(tier2Candidate.providerId);
      const decision: RoutingDecision = {
        decisionId,
        outcome: 'SELECTED',
        selectedResourceId: tier2Candidate.resourceId,
        selectedProviderId: tier2Candidate.providerId,
        adapterType: adapter.adapterType,
        candidateEvaluations,
        reason: `Selected LOW_QUOTA provider resource "${tier2Candidate.resourceId}" (model: "${tier2Candidate.modelName}").`,
        createdAt,
      };
      this.recordDecisionEvent(request, decision);
      return decision;
    }

    // Tier 3: Manual Bridge candidate (explicitly permitted)
    const tier3Candidate = candidateEvaluations.find(
      (c) => c.eligibility === 'ELIGIBLE' && c.tier === 3
    );
    if (tier3Candidate) {
      const decision: RoutingDecision = {
        decisionId,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
        selectedResourceId: tier3Candidate.resourceId,
        selectedProviderId: tier3Candidate.providerId,
        adapterType: 'MANUAL_BRIDGE',
        candidateEvaluations,
        reason: `Manual Bridge resource "${tier3Candidate.resourceId}" selected for manual clipboard relay.`,
        createdAt,
      };
      this.recordDecisionEvent(request, decision);
      return decision;
    }

    // No eligible candidate found
    const decision: RoutingDecision = {
      decisionId,
      outcome: 'NO_ELIGIBLE_PROVIDER',
      selectedResourceId: null,
      selectedProviderId: null,
      adapterType: null,
      candidateEvaluations,
      reason:
        'No candidate provider resource satisfied capability, health, and quota eligibility criteria.',
      createdAt,
    };
    this.recordDecisionEvent(request, decision);
    return decision;
  }

  private recordDecisionEvent(request: RoutingRequest, decision: RoutingDecision): void {
    if (!this.eventService) return;

    this.eventService.record(
      request.projectId,
      'PROVIDER_ROUTING_DECISION',
      `Routing decision: ${decision.outcome} for task ${request.taskId} (${decision.reason})`,
      {
        decisionId: decision.decisionId,
        projectId: request.projectId,
        taskId: request.taskId,
        attemptId: request.attemptId ?? null,
        candidateResourceIds: request.candidateResourceIds,
        selectedResourceId: decision.selectedResourceId,
        selectedProviderId: decision.selectedProviderId,
        outcome: decision.outcome,
        reason: decision.reason,
        candidateEvaluations: decision.candidateEvaluations,
      },
      request.taskId
    );
  }
}
