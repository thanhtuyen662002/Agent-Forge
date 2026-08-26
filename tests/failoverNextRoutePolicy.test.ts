import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FailoverNextRoutePolicyService } from '../src/core/services/FailoverNextRoutePolicyService';
import {
  AgentAssignment,
  FailoverDecision,
  FailoverLineageContext,
  FailoverPolicyParseResult,
  FailoverPolicyV1,
  FailoverTransition,
} from '../src/core/types/domain';

function makeValidPolicy(overrides: Partial<Extract<FailoverPolicyV1, { enabled: true }>> = {}): FailoverPolicyParseResult {
  const policy: FailoverPolicyV1 = {
    version: 1,
    enabled: true,
    max_failover_attempts: 3,
    same_account_retries: 2,
    allow_cross_account: true,
    allow_cross_provider: true,
    ...overrides,
  };
  return { status: 'VALID', policy };
}

function makeAssignment(
  id: string,
  attemptId: string | null,
  overrides: Partial<AgentAssignment> = {}
): AgentAssignment {
  return {
    id,
    project_id: 'proj-1',
    task_id: 'task-1',
    attempt_id: attemptId,
    role_profile_id: 'role-dev',
    agent_profile_id: 'agent-prof-1',
    selected_provider_id: 'prov-openai',
    selected_account_id: 'acc-1',
    selected_resource_id: 'res-1',
    selected_worker_slot_id: 'slot-1',
    routing_decision_id: 'rd-1',
    preferred_metadata: null,
    status: 'RUNNING',
    created_at: '2026-08-26T00:00:00Z',
    ended_at: null,
    ...overrides,
  };
}

describe('FailoverNextRoutePolicyService (R5H4)', () => {
  // =========================================================================
  // 1. Policy & Decision Input Authority
  // =========================================================================
  it('1. returns FAILOVER_NOT_AUTHORIZED when failover policy is ABSENT', () => {
    const policyResult: FailoverPolicyParseResult = { status: 'ABSENT' };
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('FAILOVER_NOT_AUTHORIZED');
    expect(plan.stages).toHaveLength(0);
  });

  it('2. returns INVALID_INPUT when policyResult status is INVALID', () => {
    const policyResult: FailoverPolicyParseResult = { status: 'INVALID', error: 'max_failover_attempts must be positive' };
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('INVALID_INPUT');
  });

  it('3. returns FAILOVER_NOT_AUTHORIZED when failover policy is disabled', () => {
    const policyResult: FailoverPolicyParseResult = { status: 'VALID', policy: { version: 1, enabled: false } };
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('FAILOVER_NOT_AUTHORIZED');
    expect(plan.stages).toHaveLength(0);
  });

  it('4. returns FAILOVER_NOT_AUTHORIZED when decision outcome is not FAILOVER_ALLOWED', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'NON_FAILOVERABLE', category: 'SYNTAX_ERROR', reason: 'Fatal error' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('FAILOVER_NOT_AUTHORIZED');
    expect(plan.stages).toHaveLength(0);
  });

  it('5. returns INVALID_INPUT when decision is ALLOWED but budget is already exhausted in lineage', () => {
    const policyResult = makeValidPolicy({ max_failover_attempts: 2 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    // Lineage shows 2 failover attempts used already
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
      { id: 't2', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-2', successor_attempt_id: 'att-3', failover_ordinal: 2, created_at: '2026-08-26T00:01:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-3', rootAttemptId: 'att-1', failoverAttemptsUsed: 2, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1'),
      makeAssignment('asg-2', 'att-2'),
      makeAssignment('asg-3', 'att-3'),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('budget inconsistency');
    expect(plan.stages).toHaveLength(0);
  });

  // =========================================================================
  // 2. Lineage Structural Invariants
  // =========================================================================
  it('6. evaluates single-attempt lineage correctly (root attempt, 0 transitions, used 0)', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('ROUTE_STAGES_READY');
    expect(plan.currentAttemptId).toBe('att-1');
    expect(plan.consecutiveSameAccountRetriesUsed).toBe(0);
    expect(plan.stages.length).toBeGreaterThan(0);
  });

  it('7. returns INVALID_INPUT when forged lineage has broken root mismatch in transitions', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-forged-root', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [makeAssignment('asg-1', 'att-1'), makeAssignment('asg-2', 'att-2')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('root');
  });

  it('8. returns INVALID_INPUT when forged lineage has an ordinal gap', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 2, created_at: '2026-08-26T00:00:00Z' }, // gap: 2 instead of 1
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [makeAssignment('asg-1', 'att-1'), makeAssignment('asg-2', 'att-2')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Ordinal gap');
  });

  // =========================================================================
  // 3. Assignment History Binding & Chain Consistency
  // =========================================================================
  it('9. returns INVALID_INPUT when current assignment is missing from assignments array', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments: AgentAssignment[] = []; // empty!

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Missing AgentAssignment for lineage attempt "att-1"');
  });

  it('10. returns INVALID_INPUT when historical lineage assignment is missing', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [makeAssignment('asg-2', 'att-2')]; // missing att-1 assignment!

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Missing AgentAssignment for lineage attempt "att-1"');
  });

  it('11. returns INVALID_INPUT when duplicate assignments exist for a single lineage attempt', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [
      makeAssignment('asg-1a', 'att-1'),
      makeAssignment('asg-1b', 'att-1'),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Duplicate AgentAssignment');
  });

  it('12. returns INVALID_INPUT when cross-task assignment history is detected', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { task_id: 'task-other' }), // cross-task!
      makeAssignment('asg-2', 'att-2', { task_id: 'task-1' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Cross-task');
  });

  it('13. returns INVALID_INPUT when cross-project assignment history is detected', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { project_id: 'proj-other' }), // cross-project!
      makeAssignment('asg-2', 'att-2', { project_id: 'proj-1' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Cross-project');
  });

  it('14. returns INVALID_INPUT when cross-role assignment history is detected', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { role_profile_id: 'role-qa' }), // cross-role!
      makeAssignment('asg-2', 'att-2', { role_profile_id: 'role-dev' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Cross-role');
  });

  it('15. returns INVALID_INPUT when cross-agent-profile assignment history is detected', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { agent_profile_id: 'agent-prof-2' }), // cross-profile!
      makeAssignment('asg-2', 'att-2', { agent_profile_id: 'agent-prof-1' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('INVALID_INPUT');
    expect(plan.reason).toContain('Cross-agent-profile');
  });

  // =========================================================================
  // 4. Consecutive Same-Account Retry Counter Semantics
  // =========================================================================
  it('16. calculates consecutiveSameAccountRetriesUsed = 0 for single root attempt on account X', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 2 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-X' })];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.consecutiveSameAccountRetriesUsed).toBe(0);
  });

  it('17. calculates consecutiveSameAccountRetriesUsed = 1 for X -> X', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 2 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-X' }),
      makeAssignment('asg-2', 'att-2', { selected_account_id: 'acc-X' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.consecutiveSameAccountRetriesUsed).toBe(1);
  });

  it('18. calculates consecutiveSameAccountRetriesUsed = 2 for X -> X -> X', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 3 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
      { id: 't2', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-2', successor_attempt_id: 'att-3', failover_ordinal: 2, created_at: '2026-08-26T00:01:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-3', rootAttemptId: 'att-1', failoverAttemptsUsed: 2, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-X' }),
      makeAssignment('asg-2', 'att-2', { selected_account_id: 'acc-X' }),
      makeAssignment('asg-3', 'att-3', { selected_account_id: 'acc-X' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.consecutiveSameAccountRetriesUsed).toBe(2);
  });

  it('19. resets consecutiveSameAccountRetriesUsed = 0 for X -> Y', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 2 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-X' }),
      makeAssignment('asg-2', 'att-2', { selected_account_id: 'acc-Y' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.consecutiveSameAccountRetriesUsed).toBe(0);
  });

  it('20. calculates consecutiveSameAccountRetriesUsed = 1 for X -> Y -> Y', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 2 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
      { id: 't2', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-2', successor_attempt_id: 'att-3', failover_ordinal: 2, created_at: '2026-08-26T00:01:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-3', rootAttemptId: 'att-1', failoverAttemptsUsed: 2, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-X' }),
      makeAssignment('asg-2', 'att-2', { selected_account_id: 'acc-Y' }),
      makeAssignment('asg-3', 'att-3', { selected_account_id: 'acc-Y' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.consecutiveSameAccountRetriesUsed).toBe(1);
  });

  // =========================================================================
  // 5. Stage Generation and Constraint Semantics
  // =========================================================================
  it('21. emits no same-account stage when same_account_retries = 0', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 0, allow_cross_account: true, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-1' })];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('ROUTE_STAGES_READY');
    const sameAccountStage = plan.stages.find((s) => s.kind === 'SAME_ACCOUNT_RETRY');
    expect(sameAccountStage).toBeUndefined();
    expect(plan.stages.map((s) => s.kind)).toEqual(['CROSS_ACCOUNT_SAME_PROVIDER', 'CROSS_PROVIDER']);
  });

  it('22. emits required current provider and account in same-account stage when budget is available', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 1 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-1', selected_resource_id: 'res-1' })];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    const stage = plan.stages.find((s) => s.kind === 'SAME_ACCOUNT_RETRY');
    expect(stage).toBeDefined();
    expect(stage?.requiredProviderId).toBe('prov-openai');
    expect(stage?.requiredAccountId).toBe('acc-1');
    expect(stage?.requiredResourceId).toBeNull();
  });

  it('23. permits current candidate retry in same-account stage (excludedCandidateIds is empty)', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 1 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-1', selected_resource_id: 'res-1' })];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    const stage = plan.stages.find((s) => s.kind === 'SAME_ACCOUNT_RETRY');
    expect(stage?.excludedCandidateIds).toEqual([]);
    expect(stage?.excludedAccountIds).toEqual([]);
    expect(stage?.excludedProviderIds).toEqual([]);
  });

  it('24. returns NO_ROUTE_SCOPE_ALLOWED when both cross permissions are false and same-account retry budget is exhausted', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 1, allow_cross_account: false, allow_cross_provider: false });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    // Already used 1 same-account retry (A -> B on acc-1)
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-1' }),
      makeAssignment('asg-2', 'att-2', { selected_account_id: 'acc-1' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('NO_ROUTE_SCOPE_ALLOWED');
    expect(plan.stages).toHaveLength(0);
  });

  it('25. emits required current provider and excludes used accounts under current provider for cross-account stage', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-1', selected_resource_id: 'res-1' })];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.stages).toHaveLength(1);
    const stage = plan.stages[0];
    expect(stage.kind).toBe('CROSS_ACCOUNT_SAME_PROVIDER');
    expect(stage.requiredProviderId).toBe('prov-openai');
    expect(stage.requiredAccountId).toBeNull();
    expect(stage.excludedAccountIds).toEqual(['acc-1']);
    expect(stage.excludedCandidateIds).toEqual(['acc-1:res-1']);
    expect(stage.excludedProviderIds).toEqual([]);
  });

  it('26. emits cross-provider stage excluding all previously used providers, accounts, and candidates in lineage', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 0, allow_cross_account: false, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-1', selected_resource_id: 'res-1' })];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.stages).toHaveLength(1);
    const stage = plan.stages[0];
    expect(stage.kind).toBe('CROSS_PROVIDER');
    expect(stage.requiredProviderId).toBeNull();
    expect(stage.requiredAccountId).toBeNull();
    expect(stage.excludedProviderIds).toEqual(['prov-openai']);
    expect(stage.excludedAccountIds).toEqual(['acc-1']);
    expect(stage.excludedCandidateIds).toEqual(['acc-1:res-1']);
  });

  it('27. emits 3 ordered stages when both cross permissions are true and same-account retry is available', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 1, allow_cross_account: true, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('ROUTE_STAGES_READY');
    expect(plan.stages.map((s) => s.kind)).toEqual([
      'SAME_ACCOUNT_RETRY',
      'CROSS_ACCOUNT_SAME_PROVIDER',
      'CROSS_PROVIDER',
    ]);
  });

  it('28. emits 2 ordered stages (cross-account, cross-provider) after same-account retry budget is exhausted', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 1, allow_cross_account: true, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-1' }),
      makeAssignment('asg-2', 'att-2', { selected_account_id: 'acc-1' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.stages.map((s) => s.kind)).toEqual([
      'CROSS_ACCOUNT_SAME_PROVIDER',
      'CROSS_PROVIDER',
    ]);
  });

  it('29. prevents revisiting historically used accounts under current provider in cross-account stage', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 1, allow_cross_account: true, allow_cross_provider: false });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    // Chain: att-1(acc-1, res-1) -> att-2(acc-2, res-2) under provider prov-openai
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-1', selected_resource_id: 'res-1' }),
      makeAssignment('asg-2', 'att-2', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-2', selected_resource_id: 'res-2' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    const crossAccountStage = plan.stages.find((s) => s.kind === 'CROSS_ACCOUNT_SAME_PROVIDER');
    expect(crossAccountStage).toBeDefined();
    // Must exclude BOTH acc-1 and acc-2
    expect(crossAccountStage?.excludedAccountIds).toEqual(['acc-1', 'acc-2']);
    expect(crossAccountStage?.excludedCandidateIds).toEqual(['acc-1:res-1', 'acc-2:res-2']);
  });

  it('30. prevents revisiting historically used providers in cross-provider stage', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 0, allow_cross_account: false, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    // Chain: att-1(prov-openai, acc-1) -> att-2(prov-anthropic, acc-2)
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-2', rootAttemptId: 'att-1', failoverAttemptsUsed: 1, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-1', selected_resource_id: 'res-1' }),
      makeAssignment('asg-2', 'att-2', { selected_provider_id: 'prov-anthropic', selected_account_id: 'acc-2', selected_resource_id: 'res-2' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    const crossProviderStage = plan.stages.find((s) => s.kind === 'CROSS_PROVIDER');
    expect(crossProviderStage).toBeDefined();
    // Must exclude BOTH prov-anthropic and prov-openai
    expect(crossProviderStage?.excludedProviderIds).toEqual(['prov-anthropic', 'prov-openai']);
    expect(crossProviderStage?.excludedAccountIds).toEqual(['acc-1', 'acc-2']);
  });

  it('31. formats candidate identities as accountId:resourceId', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 0, allow_cross_account: true, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'my-acc', selected_resource_id: 'my-res' })];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    const crossAccStage = plan.stages.find((s) => s.kind === 'CROSS_ACCOUNT_SAME_PROVIDER');
    expect(crossAccStage?.excludedCandidateIds).toEqual(['my-acc:my-res']);
  });

  it('32. guarantees all exclusion arrays are canonical, de-duplicated, and sorted lexicographically', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 0, allow_cross_account: true, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    // Chain with multiple attempts: att-1(acc-Z, res-Z) -> att-2(acc-A, res-A) -> att-3(acc-Z, res-Z2)
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
      { id: 't2', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-2', successor_attempt_id: 'att-3', failover_ordinal: 2, created_at: '2026-08-26T00:01:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-3', rootAttemptId: 'att-1', failoverAttemptsUsed: 2, transitions };
    const assignments = [
      makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-1', selected_account_id: 'acc-Z', selected_resource_id: 'res-Z' }),
      makeAssignment('asg-2', 'att-2', { selected_provider_id: 'prov-1', selected_account_id: 'acc-A', selected_resource_id: 'res-A' }),
      makeAssignment('asg-3', 'att-3', { selected_provider_id: 'prov-1', selected_account_id: 'acc-Z', selected_resource_id: 'res-Z2' }),
    ];

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    const stage = plan.stages.find((s) => s.kind === 'CROSS_ACCOUNT_SAME_PROVIDER');
    expect(stage?.excludedAccountIds).toEqual(['acc-A', 'acc-Z']); // unique & sorted
    expect(stage?.excludedCandidateIds).toEqual(['acc-A:res-A', 'acc-Z:res-Z', 'acc-Z:res-Z2']); // sorted
  });

  it('33. is invariant under assignment input array permutations', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 2, allow_cross_account: true, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const transitions: FailoverTransition[] = [
      { id: 't1', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-1', successor_attempt_id: 'att-2', failover_ordinal: 1, created_at: '2026-08-26T00:00:00Z' },
      { id: 't2', task_id: 'task-1', root_attempt_id: 'att-1', source_attempt_id: 'att-2', successor_attempt_id: 'att-3', failover_ordinal: 2, created_at: '2026-08-26T00:01:00Z' },
    ];
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-3', rootAttemptId: 'att-1', failoverAttemptsUsed: 2, transitions };

    const a1 = makeAssignment('asg-1', 'att-1', { selected_account_id: 'acc-1' });
    const a2 = makeAssignment('asg-2', 'att-2', { selected_account_id: 'acc-2' });
    const a3 = makeAssignment('asg-3', 'att-3', { selected_account_id: 'acc-2' });

    const plan1 = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments: [a1, a2, a3] });
    const plan2 = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments: [a3, a1, a2] });
    const plan3 = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments: [a2, a3, a1] });

    expect(plan1).toEqual(plan2);
    expect(plan1).toEqual(plan3);
  });

  it('34. ignores unrelated task assignments that are not part of the lineage', () => {
    const policyResult = makeValidPolicy({ same_account_retries: 2, allow_cross_account: true, allow_cross_provider: true });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };

    const a1 = makeAssignment('asg-1', 'att-1', { selected_provider_id: 'prov-openai', selected_account_id: 'acc-1' });
    const aUnrelated1 = makeAssignment('asg-unrelated', 'att-unrelated', { selected_provider_id: 'prov-unrelated', selected_account_id: 'acc-unrelated' });
    const aUnrelated2 = makeAssignment('asg-null-att', null, { selected_provider_id: 'prov-unrelated2', selected_account_id: 'acc-unrelated2' });

    const planWithout = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments: [a1] });
    const planWith = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments: [a1, aUnrelated1, aUnrelated2] });

    expect(planWith).toEqual(planWithout);
  });

  it('35. does not include candidateRefs, winner, or live adapter fields in the plan', () => {
    const policyResult = makeValidPolicy();
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const plan: any = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect('candidateRefs' in plan).toBe(false);
    expect('winner' in plan).toBe(false);
    expect('selectedCandidateId' in plan).toBe(false);
    expect('selectedAccountId' in plan).toBe(false);
    expect('selectedProviderId' in plan).toBe(false);

    for (const stage of plan.stages) {
      expect('candidateRefs' in stage).toBe(false);
      expect('winner' in stage).toBe(false);
    }
  });

  it('36. stage fallback does not mutate inputs or failover budget', () => {
    const policyResult = makeValidPolicy({ max_failover_attempts: 3 });
    const decision: FailoverDecision = { outcome: 'FAILOVER_ALLOWED', category: 'API_RATE_LIMIT', reason: 'Rate limited' };
    const lineage: FailoverLineageContext = { currentAttemptId: 'att-1', rootAttemptId: 'att-1', failoverAttemptsUsed: 0, transitions: [] };
    const assignments = [makeAssignment('asg-1', 'att-1')];

    const lineageCopy = JSON.parse(JSON.stringify(lineage));
    const assignmentsCopy = JSON.parse(JSON.stringify(assignments));

    const plan = FailoverNextRoutePolicyService.evaluate({ policyResult, decision, lineage, assignments });
    expect(plan.outcome).toBe('ROUTE_STAGES_READY');

    // Invariants preserved: no mutation of lineage or assignments
    expect(lineage).toEqual(lineageCopy);
    expect(assignments).toEqual(assignmentsCopy);
  });

  // =========================================================================
  // 6. Source Boundary Test
  // =========================================================================
  it('37. verifies FailoverNextRoutePolicyService has zero forbidden imports', () => {
    const serviceFilePath = path.join(__dirname, '../src/core/services/FailoverNextRoutePolicyService.ts');
    const content = fs.readFileSync(serviceFilePath, 'utf8');

    expect(content).not.toContain('Repository');
    expect(content).not.toContain('RoleAwareRoutingService');
    expect(content).not.toContain('FailoverLineageService');
    expect(content).not.toContain('FailoverPolicyParser');
    expect(content).not.toContain('FailoverDecisionService');
    expect(content).not.toContain('ExecutionFailureClassifier');
    expect(content).not.toContain('AccountHealthService');
    expect(content).not.toContain('ExecutionAuthorizationService');
    expect(content).not.toContain('ConcurrentExecutionScheduler');
    expect(content).not.toContain('ProviderDispatchService');
    expect(content).not.toContain('WorkerSlotLeaseService');
    expect(content).not.toContain('ProviderRegistry');
    expect(content).not.toContain('EventService');
  });
});
