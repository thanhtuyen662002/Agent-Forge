import { Repository } from '../database/repositories';
import {
  ProviderDispatchExecutionResult,
} from './ProviderDispatchService';
import {
  ExecutionFailureClassifier,
} from './ExecutionFailureClassifier';
import {
  ProviderHealthObservation,
  ProviderHealthObservationCategory,
  ProviderHealthObservationIngestResult,
} from '../types/domain';

export class ProviderHealthObservationService {
  constructor(private readonly repo: Repository) {}

  /**
   * Records a bounded, durable provider health observation from a trusted
   * ProviderDispatchExecutionResult.
   *
   * Enforces strict provenance validation, authorization coherence, and assignment
   * coherence fail-closed. Ingestion is idempotent by authorizationId.
   */
  public recordObservation(
    providerResult: ProviderDispatchExecutionResult
  ): ProviderHealthObservationIngestResult {
    // 1. Precondition: Trusted provenance must be present
    if (!providerResult || !providerResult.providerExecutionProvenance) {
      return {
        status: 'NOT_APPLICABLE',
        observation: null,
        reason: 'PROVENANCE_MISSING: Result has no provider execution provenance.',
      };
    }

    const provenance = providerResult.providerExecutionProvenance;

    // 2. Validate provenance structure & coherence
    if (provenance.version !== 1) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `MALFORMED_PROVENANCE_VERSION: Unsupported provenance version ${provenance.version}.`,
      };
    }

    if (provenance.source !== 'PROVIDER_DISPATCH_SERVICE') {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `MALFORMED_PROVENANCE_SOURCE: Invalid provenance source "${provenance.source}".`,
      };
    }

    if (provenance.executionId !== providerResult.executionId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `INCOHERENT_EXECUTION_ID: Provenance executionId "${provenance.executionId}" does not match result executionId "${providerResult.executionId}".`,
      };
    }

    if (
      provenance.adapterInvocation !== 'RETURNED' &&
      provenance.adapterInvocation !== 'THREW'
    ) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `MALFORMED_ADAPTER_INVOCATION: Invalid adapterInvocation "${provenance.adapterInvocation}".`,
      };
    }

    if (!provenance.authorizationId || provenance.authorizationId.trim() === '') {
      return {
        status: 'REJECTED',
        observation: null,
        reason: 'MISSING_AUTHORIZATION_ID: Provenance authorizationId is missing or empty.',
      };
    }

    // 3. Check accountId & assignmentId
    if (!provenance.accountId || provenance.accountId.trim() === '') {
      return {
        status: 'NOT_APPLICABLE',
        observation: null,
        reason: 'NULL_OR_EMPTY_ACCOUNT_ID: Provenance has no associated provider account ID.',
      };
    }

    if (!provenance.assignmentId || provenance.assignmentId.trim() === '') {
      return {
        status: 'REJECTED',
        observation: null,
        reason: 'MISSING_ASSIGNMENT_ID: Account-bound provenance must have non-empty assignmentId.',
      };
    }

    // 4. Load and validate durable ExecutionAuthorization
    const auth = this.repo.getExecutionAuthorization(provenance.authorizationId);
    if (!auth) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `AUTHORIZATION_NOT_FOUND: ExecutionAuthorization "${provenance.authorizationId}" not found.`,
      };
    }

    if (auth.status !== 'DISPATCHED') {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `AUTHORIZATION_NOT_DISPATCHED: ExecutionAuthorization "${auth.id}" status is "${auth.status}", expected "DISPATCHED".`,
      };
    }

    if (auth.project_id !== provenance.projectId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `PROJECT_ID_MISMATCH: Authorization project_id "${auth.project_id}" does not match provenance projectId "${provenance.projectId}".`,
      };
    }

    if (auth.task_id !== provenance.taskId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `TASK_ID_MISMATCH: Authorization task_id "${auth.task_id}" does not match provenance taskId "${provenance.taskId}".`,
      };
    }

    if (auth.attempt_id !== provenance.attemptId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ATTEMPT_ID_MISMATCH: Authorization attempt_id "${auth.attempt_id}" does not match provenance attemptId "${provenance.attemptId}".`,
      };
    }

    if (auth.routing_decision_id !== provenance.routingDecisionId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ROUTING_DECISION_ID_MISMATCH: Authorization routing_decision_id "${auth.routing_decision_id}" does not match provenance routingDecisionId "${provenance.routingDecisionId}".`,
      };
    }

    if (auth.selected_provider_id !== provenance.providerId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `PROVIDER_ID_MISMATCH: Authorization selected_provider_id "${auth.selected_provider_id}" does not match provenance providerId "${provenance.providerId}".`,
      };
    }

    if (auth.selected_resource_id !== provenance.resourceId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `RESOURCE_ID_MISMATCH: Authorization selected_resource_id "${auth.selected_resource_id}" does not match provenance resourceId "${provenance.resourceId}".`,
      };
    }

    // 5. Load and validate durable AgentAssignment
    const assignment = this.repo.getAgentAssignment(provenance.assignmentId);
    if (!assignment) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_NOT_FOUND: AgentAssignment "${provenance.assignmentId}" not found.`,
      };
    }

    if (assignment.selected_account_id !== provenance.accountId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_ACCOUNT_ID_MISMATCH: Assignment selected_account_id "${assignment.selected_account_id}" does not match provenance accountId "${provenance.accountId}".`,
      };
    }

    if (assignment.selected_provider_id !== provenance.providerId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_PROVIDER_ID_MISMATCH: Assignment selected_provider_id "${assignment.selected_provider_id}" does not match provenance providerId "${provenance.providerId}".`,
      };
    }

    if (assignment.selected_resource_id !== provenance.resourceId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_RESOURCE_ID_MISMATCH: Assignment selected_resource_id "${assignment.selected_resource_id}" does not match provenance resourceId "${provenance.resourceId}".`,
      };
    }

    if (assignment.project_id !== provenance.projectId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_PROJECT_ID_MISMATCH: Assignment project_id "${assignment.project_id}" does not match provenance projectId "${provenance.projectId}".`,
      };
    }

    if (assignment.task_id !== provenance.taskId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_TASK_ID_MISMATCH: Assignment task_id "${assignment.task_id}" does not match provenance taskId "${provenance.taskId}".`,
      };
    }

    if (assignment.attempt_id !== provenance.attemptId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_ATTEMPT_ID_MISMATCH: Assignment attempt_id "${assignment.attempt_id}" does not match provenance attemptId "${provenance.attemptId}".`,
      };
    }

    if (assignment.routing_decision_id !== provenance.routingDecisionId) {
      return {
        status: 'REJECTED',
        observation: null,
        reason: `ASSIGNMENT_ROUTING_DECISION_ID_MISMATCH: Assignment routing_decision_id "${assignment.routing_decision_id}" does not match provenance routingDecisionId "${provenance.routingDecisionId}".`,
      };
    }

    // 6. Determine canonical observation category
    let category: ProviderHealthObservationCategory;
    if (provenance.adapterInvocation === 'THREW') {
      category = 'ADAPTER_THROW';
    } else if (providerResult.status === 'COMPLETED') {
      category = 'SUCCESS';
    } else if (providerResult.status === 'AWAITING_OWNER') {
      category = 'AWAITING_OWNER';
    } else {
      const classification = ExecutionFailureClassifier.classify(providerResult);
      category = classification.category;
    }

    // 7. Assemble canonical observation
    const observation: ProviderHealthObservation = {
      authorization_id: provenance.authorizationId,
      execution_id: provenance.executionId,
      account_id: provenance.accountId,
      provider_id: provenance.providerId,
      resource_id: provenance.resourceId,
      assignment_id: provenance.assignmentId,
      attempt_id: provenance.attemptId,
      routing_decision_id: provenance.routingDecisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: provenance.mode,
      adapter_invocation: provenance.adapterInvocation,
      result_status: providerResult.status,
      classified_category: category,
      observed_at: new Date().toISOString(),
    };

    // 8. Atomic ingestion via repository
    const claimResult = this.repo.claimProviderHealthObservation(observation, providerResult);
    if (claimResult === 'ALREADY_RECORDED') {
      const existing = this.repo.getProviderHealthObservation(observation.authorization_id);
      return {
        status: 'ALREADY_RECORDED',
        observation: existing,
      };
    }

    return {
      status: 'RECORDED',
      observation,
    };
  }
}
