import { describe, expect, it } from 'vitest';
import { MIGRATIONS as facadeMigrations } from '../src/core/database/migrations';
import { MIGRATIONS as registryMigrations } from '../src/core/database/migrations/registry';

const EXPECTED_MIGRATION_NAMES = [
  '001_initial_schema',
  '002_verification_commands',
  '003_nullable_health_check',
  '004_process_run_ownership',
  '005_repair_default_agent_resource_links',
  '006_execution_authorizations',
  '007_execution_authorization_canonical_payload',
  '008_r5a_role_agnostic_agent_fabric',
  '009_r5b_durable_memory_context_fabric',
  '010_r5h4_failover_lineage_budget_idempotency',
  '011_r5h4_durable_provider_health_observations',
  '012_r5h4_provider_health_observation_ordering_authority',
  '013_r5h4_durable_provider_health_action_plan_authority',
  '014_r5h4_provider_health_cooldown_replay_authority',
  '015_r5h4_ordered_provider_health_application_idempotency',
  '016_r5i_durable_handoff_ownership_and_execution_authority',
  '017_r5i_handoff_authority_corrective_hardening',
  '018_r5i_successor_context_authority',
  '019_r5i_execution_authorization_assignment_and_unique_successor_auth',
  '020_r5i_crash_recovery_and_execution_lifecycle_authority',
  '021_r5j_mcp_client_session_authority',
  '022_r5j_coder_submission_authority',
  '023_r5j_quarantined_submission_adjudication_and_verification_admission',
  '024_r5j_reviewer_session_authority',
] as const;

describe('migration registry contract', () => {
  it('exposes one immutable, contiguous registry through the compatibility facade', () => {
    expect(facadeMigrations).toBe(registryMigrations);
    expect(Object.isFrozen(registryMigrations)).toBe(true);
    expect(registryMigrations.map((migration) => migration.version)).toEqual(
      EXPECTED_MIGRATION_NAMES.map((_, index) => index + 1),
    );
    expect(registryMigrations.map((migration) => migration.name)).toEqual([...EXPECTED_MIGRATION_NAMES]);
    expect(new Set(registryMigrations.map((migration) => migration.version)).size).toBe(registryMigrations.length);
    expect(new Set(registryMigrations.map((migration) => migration.name)).size).toBe(registryMigrations.length);
  });
});
