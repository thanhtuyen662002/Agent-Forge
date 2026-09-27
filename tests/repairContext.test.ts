import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AutonomyStore } from '../src/core/autonomy/store';
import { AutonomySupervisor } from '../src/core/autonomy/supervisor';
import {
  ProviderEndpointConfig,
  parseProviderEndpointConfig,
} from '../src/core/autonomy/providerEndpoint';
import {
  loadOmniRouteEndpointFromEnvironment,
  loadOmniRouteRepairCoderEndpointFromEnvironment,
} from '../src/core/autonomy/responsesEndpoint';
import {
  CoderEditBundle,
  CoderResourceBinding,
  resolveCoderProvider,
} from '../src/core/autonomy/responsesCoderEndpoint';
import {
  FailedApproach,
  PreviousCoderAction,
  RepairContextPackage,
  RepairContextPackageSchema,
  ReviewerRepairFinding,
  ReviewerRepairFindingSchema,
  buildRepairContextPackage,
  buildRepairPrompt,
  canonicalSerializeRepairContext,
  computeNormalizedPatchHash,
  computeRepairContextHash,
  deriveFindingId,
  detectNoProgress,
  extractFailingTestSignatures,
  getEscalationStage,
  normalizeReviewerFindings,
  parseRepairContextPackage,
  reconcileFindingClosure,
} from '../src/core/autonomy/repairContext';
import { GitEvidence, ManagerReview } from '../src/core/autonomy/contracts';
import type { RepairFinding } from '../src/core/autonomy/contracts';
import { ExecutionAuthorization } from '../src/core/types/domain';

const shaA = '1111111111111111111111111111111111111111';
const shaB = '2222222222222222222222222222222222222222';

function standardCoderEndpoint(): ProviderEndpointConfig {
  return parseProviderEndpointConfig({
    resource_id: 'coder-omniroute',
    role: 'CODER',
    adapter_type: 'EXTERNAL_ROUTER',
    base_url: 'https://router.example.test/v1',
    allow_insecure_http: false,
    model_or_route: 'coder-standard-model',
    auth_source: 'env://TEST_CODER_AUTH',
    auth_header_name: 'X-Company-Auth',
    priority: 280,
    timeout_ms: 5000,
    enabled: true,
    health_state: 'AVAILABLE',
    cooldown_state: { active: false, until: null, reason: null },
    capabilities: ['CODING'],
  });
}

function repairCoderEndpoint(enabled = true, healthState = 'AVAILABLE'): ProviderEndpointConfig {
  return parseProviderEndpointConfig({
    resource_id: 'repair-coder-omniroute',
    role: 'CODER',
    adapter_type: 'EXTERNAL_ROUTER',
    base_url: 'https://router.example.test/v1',
    allow_insecure_http: false,
    model_or_route: 'coder-repair-specialist-model',
    auth_source: 'env://TEST_CODER_AUTH',
    auth_header_name: 'X-Company-Auth',
    priority: 285,
    timeout_ms: 10000,
    enabled,
    health_state: healthState as any,
    cooldown_state: { active: false, until: null, reason: null },
    capabilities: ['CODING'],
  });
}

type SampleRepairPackageOverrides = Partial<RepairContextPackage> & {
  taskId?: string;
  authorizationId?: string;
  ownershipEpoch?: number;
  baseSha?: string;
  currentHeadSha?: string;
  currentSnapshotSha?: string;
  originalObjective?: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  requiredTests?: string[];
  reviewerFindings?: Array<{
    finding_id?: string | null;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    title: string;
    description: string;
    file_path?: string | null;
    line_number?: number | null;
    evidence?: string | null;
    required_action?: string | null;
    acceptance_evidence?: string | null;
  }>;
  requiredActions?: string[];
  previousResolvedFindingIds?: string[];
  unresolvedFindingIds?: string[];
  previousCoderActions?: PreviousCoderAction[];
  knownFailedApproaches?: FailedApproach[];
  nonRegressionConstraints?: string[];
  selectedResourceId?: string | null;
  selectedProviderId?: string | null;
};

function sampleRepairPackage(overrides: SampleRepairPackageOverrides = {}): RepairContextPackage {
  const acceptanceCriteria = overrides.acceptanceCriteria ?? overrides.acceptance_criteria ?? ['All tests must pass', 'No regressions in schema'];
  const baseSha = overrides.baseSha ?? overrides.base_sha ?? shaA;
  const currentHeadSha = overrides.currentHeadSha ?? overrides.current_head_sha ?? shaA;
  const currentSnapshotSha = overrides.currentSnapshotSha ?? overrides.current_snapshot_sha ?? 'snap-1111';
  const reviewerFindings = (overrides.reviewerFindings ?? overrides.previous_reviewer_findings ?? [
    {
      finding_id: 'finding-101',
      severity: 'HIGH' as const,
      title: 'Validation fails on null input',
      description: 'validate() throws TypeError when passed null',
      file_path: 'src/validator.ts',
      line_number: 42,
      required_action: 'Handle null gracefully and return false',
    },
  ]);
  const requiredActions = overrides.requiredActions ?? overrides.required_actions ?? ['Handle null gracefully and return false'];
  const previousResolvedFindingIds = overrides.previousResolvedFindingIds ?? overrides.resolved_finding_ids ?? [];
  const unresolvedFindingIds = overrides.unresolvedFindingIds ?? overrides.unresolved_finding_ids;
  const previousCoderActions = overrides.previousCoderActions ?? overrides.previous_coder_actions ?? [];
  const knownFailedApproaches = overrides.knownFailedApproaches ?? overrides.known_failed_approaches ?? [];

  return buildRepairContextPackage({
    taskId: overrides.taskId ?? overrides.task_id ?? 'TSK-TEST-001',
    authorizationId: overrides.authorizationId ?? overrides.authorization_id ?? 'auth-test-001',
    ownershipEpoch: overrides.ownershipEpoch ?? overrides.ownership_epoch ?? 1,
    attempt: overrides.attempt ?? 1,
    baseSha,
    currentHeadSha,
    currentSnapshotSha,
    originalObjective: overrides.originalObjective ?? overrides.original_objective ?? 'Fix validation logic and pass tests',
    acceptanceCriteria,
    allowedPaths: overrides.allowedPaths ?? overrides.allowed_paths ?? ['src/validator.ts', 'tests/validator.test.ts'],
    forbiddenPaths: overrides.forbiddenPaths ?? overrides.forbidden_paths ?? ['.git', 'main'],
    requiredTests: overrides.requiredTests ?? overrides.required_tests ?? ['npm test tests/validator.test.ts'],
    reviewerFindings,
    requiredActions,
    previousResolvedFindingIds,
    unresolvedFindingIds,
    previousCoderActions,
    knownFailedApproaches,
    nonRegressionConstraints: overrides.nonRegressionConstraints ?? overrides.non_regression_constraints,
    selectedResourceId: overrides.selectedResourceId ?? overrides.selected_resource_id ?? null,
    selectedProviderId: overrides.selectedProviderId ?? overrides.selected_provider_id ?? null,
  });
}

describe('Repair Convergence Contract (repaircontext.v1)', () => {
  describe('1. Schema, Deterministic Serialization & Hash', () => {
    it('validates a complete, strict repaircontext.v1 package', () => {
      const pkg = sampleRepairPackage();
      const parsed = RepairContextPackageSchema.parse(pkg);
      expect(parsed.protocol_version).toBe('repaircontext.v1');
      expect(parsed.task_id).toBe('TSK-TEST-001');
      expect(parsed.attempt).toBe(1);
      expect(parsed.escalation_stage).toBe('NORMAL_CODER');
      expect(parsed.previous_reviewer_findings).toHaveLength(1);
    });

    it('rejects packages missing acceptance criteria or having invalid SHAs', () => {
      expect(() => {
        sampleRepairPackage({ acceptance_criteria: [] });
      }).toThrow();

      expect(() => {
        sampleRepairPackage({ base_sha: 'invalid-not-40-chars' });
      }).toThrow();
    });

    it('produces deterministic canonical serialization regardless of property insertion order', () => {
      const pkgA = sampleRepairPackage();
      // Construct pkgB with identical properties in reversed order
      const pkgB: any = {};
      const keys = Object.keys(pkgA).reverse();
      for (const k of keys) {
        pkgB[k] = (pkgA as any)[k];
      }

      const serA = canonicalSerializeRepairContext(pkgA);
      const serB = canonicalSerializeRepairContext(pkgB);
      expect(serA).toBe(serB);

      const hashA = computeRepairContextHash(pkgA);
      const hashB = computeRepairContextHash(pkgB);
      expect(hashA).toBe(hashB);
      expect(/^[0-9a-f]{64}$/.test(hashA)).toBe(true);
    });

    it('parses valid JSON string and rejects malformed or schema-invalid JSON', () => {
      const pkg = sampleRepairPackage();
      const json = JSON.stringify(pkg);
      const parsed = parseRepairContextPackage(json);
      expect(parsed.task_id).toBe(pkg.task_id);

      expect(() => parseRepairContextPackage('invalid-json')).toThrow(/CONTRACT_INVALID/);
      expect(() => parseRepairContextPackage(JSON.stringify({ protocol_version: 'wrong' }))).toThrow(/CONTRACT_INVALID/);
    });

    it('exports RepairFinding type safely under isolatedModules from contracts.ts', () => {
      const finding: RepairFinding = {
        finding_id: 'finding-isolated-modules',
        severity: 'HIGH',
        title: 'Type re-export check',
        description: 'Verify isolatedModules export',
        required_action: 'Export type properly',
        acceptance_evidence: 'TS passes without error',
        evidence: 'No TS1205',
        file_path: 'src/core/autonomy/contracts.ts',
        line_number: 213,
      };
      expect(finding.finding_id).toBe('finding-isolated-modules');
      expect(finding.required_action).toBe('Export type properly');
    });
  });

  describe('2. Stable Deterministic Reviewer Finding IDs', () => {
    it('preserves explicit finding_id when present', () => {
      const fid = deriveFindingId({
        finding_id: 'explicit-fid-999',
        title: 'Some title',
        description: 'Some desc',
      });
      expect(fid).toBe('explicit-fid-999');
    });

    it('deterministically derives finding ID when explicit ID is omitted', () => {
      const fid1 = deriveFindingId({
        title: 'Validation Error',
        description: 'Throws on undefined',
        file_path: 'src/validator.ts',
        line_number: 10,
        required_action: 'Guard against undefined',
      });

      const fid2 = deriveFindingId({
        title: '  Validation Error  ',
        description: 'Throws on undefined',
        file_path: 'src\\validator.ts', // backslash normalization
        line_number: 10,
        required_action: 'Guard against undefined',
      });

      expect(fid1).toMatch(/^finding-[0-9a-f]{16}$/);
      expect(fid1).toBe(fid2);
    });

    it('generates different IDs for semantically different findings', () => {
      const fid1 = deriveFindingId({
        title: 'Error A',
        description: 'Description A',
        required_action: 'Fix A',
      });
      const fid2 = deriveFindingId({
        title: 'Error B',
        description: 'Description B',
        required_action: 'Fix B',
      });
      expect(fid1).not.toBe(fid2);
    });

    it('normalizes reviewer findings and populates required fields', () => {
      const normalized = normalizeReviewerFindings([
        {
          severity: 'HIGH',
          title: 'Memory leak in parser',
          description: 'Buffer not freed',
          file_path: 'src\\parser.ts',
        },
      ], ['Free buffer after parse']);

      expect(normalized).toHaveLength(1);
      expect(normalized[0].finding_id).toMatch(/^finding-[0-9a-f]{16}$/);
      expect(normalized[0].file_path).toBe('src/parser.ts');
      expect(normalized[0].required_action).toBe('Free buffer after parse');
      expect(normalized[0].evidence).toBe('Buffer not freed');
      expect(normalized[0].acceptance_evidence).toBe('Verified resolution for Memory leak in parser');
    });
  });

  describe('3. Coder Bundle & Independent Finding Closure Reconciliation', () => {
    it('never treats coder claims as proof when tests fail', () => {
      const pkg = sampleRepairPackage();
      const coderBundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: pkg.task_id,
        authorization_id: pkg.authorization_id,
        source_head: pkg.base_sha,
        allowed_paths: pkg.allowed_paths,
        proposed_edits: [{ path: 'src/validator.ts', content: '// fixed' }],
        addressed_finding_ids: ['finding-101'],
        unresolved_finding_ids: [],
        changed_files: ['src/validator.ts'],
      };

      const observedEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        diff: '--- a/src/validator.ts\n+++ b/src/validator.ts\n@@ -1 +1 @@\n+// fixed',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [{ command: 'npm test', exitCode: 1, stdout: '', stderr: 'FAILED', durationMs: 100 }], // Tests failed!
      };

      const result = reconcileFindingClosure({
        repairContext: pkg,
        coderBundle,
        observedEvidence,
        latestReview: null,
      });

      expect(result.closureReconciled).toBe(false);
      expect(result.resolvedFindingIds).not.toContain('finding-101');
      expect(result.unresolvedFindingIds).toContain('finding-101');
      expect(result.unverifiedClaims).toContain('finding-101');
    });

    it('reconciles closure when tests pass, diff touches file, and manager review passes', () => {
      const pkg = sampleRepairPackage();
      const coderBundle: CoderEditBundle = {
        protocol_version: 'coderbundle.v1',
        task_id: pkg.task_id,
        authorization_id: pkg.authorization_id,
        source_head: pkg.base_sha,
        allowed_paths: pkg.allowed_paths,
        proposed_edits: [{ path: 'src/validator.ts', content: '// fixed' }],
        addressed_finding_ids: ['finding-101'],
        unresolved_finding_ids: [],
        changed_files: ['src/validator.ts'],
      };

      const observedEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        diff: '--- a/src/validator.ts\n+++ b/src/validator.ts\n@@ -1 +1 @@\n+// fixed',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [{ command: 'npm test', exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 100 }],
      };

      const latestReview: ManagerReview = {
        protocol_version: 'managerreview.v1',
        reviewed_head_sha: pkg.base_sha,
        verdict: 'PASS',
        findings: [],
        required_actions: [],
        risk: 'LOW',
        notes: 'All findings addressed cleanly',
      };

      const result = reconcileFindingClosure({
        repairContext: pkg,
        coderBundle,
        observedEvidence,
        latestReview,
      });

      expect(result.closureReconciled).toBe(true);
      expect(result.resolvedFindingIds).toContain('finding-101');
      expect(result.unresolvedFindingIds).toHaveLength(0);
      expect(result.unverifiedClaims).toHaveLength(0);
    });

    it('detects regression when an earlier resolved finding reappears in review', () => {
      const pkg = sampleRepairPackage({
        previous_reviewer_findings: [
          {
            finding_id: 'finding-101',
            severity: 'HIGH',
            title: 'Issue 1',
            description: 'Desc 1',
            required_action: 'Action 1',
            evidence: '',
            acceptance_evidence: '',
          },
        ],
        resolved_finding_ids: ['finding-101'], // Previously resolved
        unresolved_finding_ids: [],
      });

      const observedEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        diff: '...',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [{ command: 'npm test', exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 100 }],
      };

      const latestReview: ManagerReview = {
        protocol_version: 'managerreview.v1',
        reviewed_head_sha: pkg.base_sha,
        verdict: 'REPAIR',
        findings: [
          {
            finding_id: 'finding-101', // Regressed!
            severity: 'HIGH',
            title: 'Issue 1',
            description: 'Desc 1',
            required_action: 'Action 1',
          },
        ],
        required_actions: ['Action 1'],
        risk: 'HIGH',
        notes: 'Regressed issue 1',
      };

      const result = reconcileFindingClosure({
        repairContext: pkg,
        observedEvidence,
        latestReview,
      });

      expect(result.resolvedFindingIds).not.toContain('finding-101');
      expect(result.unresolvedFindingIds).toContain('finding-101');
    });
  });

  describe('4. Semantic No-Progress Detection (All 6 Categories)', () => {
    it('detects Category 1: NO_OP_WITH_UNRESOLVED_ACTIONS', () => {
      const pkg = sampleRepairPackage();
      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-1111',
        diff: '', // No diff
        changedFiles: [], // No changed files
        status: '',
        tests: [],
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
        coderBundle: {
          protocol_version: 'coderbundle.v1',
          task_id: pkg.task_id,
          authorization_id: pkg.authorization_id,
          source_head: pkg.base_sha,
          allowed_paths: pkg.allowed_paths,
          proposed_edits: [], // No edits
        },
      });

      expect(evalResult.hasNoProgress).toBe(true);
      expect(evalResult.category).toBe('NO_OP_WITH_UNRESOLVED_ACTIONS');
    });

    it('detects Category 2: UNCHANGED_SNAPSHOT_OR_DIFF', () => {
      const pkg = sampleRepairPackage({
        current_snapshot_sha: 'snap-same-1234',
        previous_coder_actions: [
          {
            attempt: 1,
            changed_files: ['src/validator.ts'],
            diff_summary: 'exact identical diff',
            test_results: [],
            addressed_finding_ids: [],
            unresolved_finding_ids: ['finding-101'],
            known_risks: [],
          },
        ],
      });

      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-same-1234', // Same snapshot
        diff: 'exact identical diff',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [],
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
      });

      expect(evalResult.hasNoProgress).toBe(true);
      expect(evalResult.category).toBe('UNCHANGED_SNAPSHOT_OR_DIFF');
    });

    it('detects Category 3: REPEATED_FAILING_TEST_SIGNATURES', () => {
      const failingTest = {
        command: 'npm test tests/validator.test.ts',
        exitCode: 1,
        stdout: '',
        stderr: 'AssertionError: expected false to be true\n at validate (src/validator.ts:42)',
        durationMs: 50,
      };
      const failingSignatures = extractFailingTestSignatures([failingTest]);

      const pkg = sampleRepairPackage({
        known_failed_approaches: [
          {
            attempt: 1,
            description: 'Failed attempt with signature match',
            test_failure_signatures: failingSignatures,
          },
        ],
      });

      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-new-5678',
        diff: 'new diff',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [failingTest], // Exact same failing test signature
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
      });

      expect(evalResult.hasNoProgress).toBe(true);
      expect(evalResult.category).toBe('REPEATED_FAILING_TEST_SIGNATURES');
    });

    it('detects Category 4: UNCHANGED_UNRESOLVED_FINDINGS', () => {
      const pkg = sampleRepairPackage({
        unresolved_finding_ids: ['finding-101', 'finding-102'],
      });

      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-new-5678',
        diff: 'some new diff',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [{ command: 'npm test', exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 50 }],
      };

      const reconciledClosure = {
        resolvedFindingIds: [],
        unresolvedFindingIds: ['finding-101', 'finding-102'], // Exactly unchanged
        closureReconciled: false,
        unverifiedClaims: [],
      };

      const latestReview: ManagerReview = {
        protocol_version: 'managerreview.v1',
        reviewed_head_sha: pkg.base_sha,
        verdict: 'REPAIR',
        findings: [
          { finding_id: 'finding-101', severity: 'HIGH', title: 'F1', description: 'D1', required_action: 'A1' },
          { finding_id: 'finding-102', severity: 'MEDIUM', title: 'F2', description: 'D2', required_action: 'A2' },
        ],
        required_actions: ['A1', 'A2'],
        risk: 'HIGH',
        notes: 'Still broken',
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
        reconciledClosure,
        latestReview,
      });

      expect(evalResult.hasNoProgress).toBe(true);
      expect(evalResult.category).toBe('UNCHANGED_UNRESOLVED_FINDINGS');
    });

    it('detects Category 5: SEMANTICALLY_EQUIVALENT_REPEATED_PATCH', () => {
      const diff1 = '--- a/src/v.ts\r\n+++ b/src/v.ts\r\n@@ -1,2 +1,2 @@\r\n-let x = 1;\r\n+let x = 2;  \r\n';
      const diff2 = '--- a/src/v.ts\n+++ b/src/v.ts\n@@ -1,2 +1,2 @@\n-let x = 1;\n+let x = 2;\n';

      const patchHash1 = computeNormalizedPatchHash(diff1);
      const patchHash2 = computeNormalizedPatchHash(diff2);
      expect(patchHash1).toBe(patchHash2);

      const pkg = sampleRepairPackage({
        previous_coder_actions: [
          {
            attempt: 1,
            changed_files: ['src/v.ts'],
            diff_summary: diff1,
            patch_hash: patchHash1,
            test_results: [],
            addressed_finding_ids: [],
            unresolved_finding_ids: ['finding-101'],
            known_risks: [],
          },
        ],
      });

      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-diff-crlf',
        diff: diff2, // CRLF vs LF variation of identical edit
        changedFiles: ['src/v.ts'],
        status: '',
        tests: [],
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
      });

      expect(evalResult.hasNoProgress).toBe(true);
      expect(evalResult.category).toBe('SEMANTICALLY_EQUIVALENT_REPEATED_PATCH');
    });

    it('detects Category 6: REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX', () => {
      const pkg = sampleRepairPackage({
        resolved_finding_ids: ['finding-101'], // Was previously resolved!
      });

      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-reverted',
        diff: 'reverted diff',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [{ command: 'npm test', exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 50 }],
      };

      const reconciledClosure = {
        resolvedFindingIds: [],
        unresolvedFindingIds: ['finding-101'], // Regressed!
        closureReconciled: false,
        unverifiedClaims: [],
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
        reconciledClosure,
      });

      expect(evalResult.hasNoProgress).toBe(true);
      expect(evalResult.category).toBe('REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX');
    });

    it('prioritizes Category 6 (REGRESSION_OR_REVERSION) over Category 5 (SEMANTICALLY_EQUIVALENT_REPEATED_PATCH)', () => {
      const diff1 = '--- a/src/v.ts\n+++ b/src/v.ts\n-let x = 1;\n+let x = 2;\n';
      const patchHash1 = computeNormalizedPatchHash(diff1);

      const pkg = sampleRepairPackage({
        resolved_finding_ids: ['finding-101'], // Was previously resolved!
        previous_coder_actions: [
          {
            attempt: 1,
            changed_files: ['src/v.ts'],
            diff_summary: diff1,
            patch_hash: patchHash1,
            test_results: [],
            addressed_finding_ids: [],
            unresolved_finding_ids: [],
            known_risks: [],
          },
        ],
      });

      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-reverted-match',
        diff: diff1, // Same patch!
        changedFiles: ['src/v.ts'],
        status: '',
        tests: [{ command: 'npm test', exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 50 }],
      };

      const reconciledClosure = {
        resolvedFindingIds: [],
        unresolvedFindingIds: ['finding-101'], // Regressed!
        closureReconciled: false,
        unverifiedClaims: [],
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
        reconciledClosure,
      });

      expect(evalResult.hasNoProgress).toBe(true);
      expect(evalResult.category).toBe('REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX');
    });

    it('returns hasNoProgress: false when valid progress is made', () => {
      const pkg = sampleRepairPackage();
      const currentEvidence: GitEvidence = {
        headSha: pkg.base_sha,
        snapshotSha: 'snap-brand-new',
        diff: 'new unique diff addressing the issue cleanly',
        changedFiles: ['src/validator.ts'],
        status: '',
        tests: [{ command: 'npm test', exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 50 }],
      };

      const reconciledClosure = {
        resolvedFindingIds: ['finding-101'],
        unresolvedFindingIds: [],
        closureReconciled: true,
        unverifiedClaims: [],
      };

      const evalResult = detectNoProgress({
        repairContext: pkg,
        currentEvidence,
        reconciledClosure,
      });

      expect(evalResult.hasNoProgress).toBe(false);
    });
  });

  describe('5. Three-Attempt Escalation Policy', () => {
    it('correctly maps attempt numbers to escalation stages', () => {
      expect(getEscalationStage(1)).toBe('NORMAL_CODER');
      expect(getEscalationStage(2)).toBe('EXPLICIT_EVIDENCE');
      expect(getEscalationStage(3)).toBe('SPECIALIST_OR_FALLBACK');
      expect(getEscalationStage(4)).toBe('SPECIALIST_OR_FALLBACK');
    });

    it('builds stage-appropriate repair prompts with escalating clarity', () => {
      const pkg = sampleRepairPackage({
        unresolved_finding_ids: ['finding-101'],
        known_failed_approaches: [
          { attempt: 1, description: 'Attempted null check at line 10 but caused NPE at line 20', test_failure_signatures: [] },
        ],
      });

      const prompt1 = buildRepairPrompt(pkg, 'NORMAL_CODER');
      expect(prompt1).toContain('Stage 1');
      expect(prompt1).not.toContain('KNOWN FAILED APPROACHES');

      const prompt2 = buildRepairPrompt(pkg, 'EXPLICIT_EVIDENCE');
      expect(prompt2).toContain('Stage 2 ESCALATION');
      expect(prompt2).toContain('UNRESOLVED FINDING IDs: finding-101');
      expect(prompt2).toContain('KNOWN FAILED APPROACHES:');
      expect(prompt2).toContain('Attempt 1: Attempted null check');

      const prompt3 = buildRepairPrompt(pkg, 'SPECIALIST_OR_FALLBACK');
      expect(prompt3).toContain('Stage 3 FINAL ESCALATION');
      expect(prompt3).toContain('Specialized repair attempt');
    });
  });

  describe('6. Configurable Repair Model Selection & Exact Authorization Binding (No Silent Fallback)', () => {
    beforeEach(() => {
      vi.unstubAllEnvs();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('loads OmniRoute repair specialist endpoint when AGENT_FORGE_REPAIR_CODER_MODEL is set', () => {
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_ENABLED', '1');
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_BASE_URL', 'https://router.example.test/v1');
      vi.stubEnv('AGENT_FORGE_REPAIR_CODER_MODEL', 'specialist-deep-repair-v1');

      const ep = loadOmniRouteRepairCoderEndpointFromEnvironment();
      expect(ep).not.toBeNull();
      expect(ep?.resource_id).toBe('repair-coder-omniroute');
      expect(ep?.model_or_route).toBe('specialist-deep-repair-v1');
      expect(ep?.priority).toBe(285);
    });

    it('returns null for repair specialist endpoint when AGENT_FORGE_REPAIR_CODER_MODEL is not configured', () => {
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_ENABLED', '1');
      vi.stubEnv('AGENT_FORGE_OMNIROUTE_BASE_URL', 'https://router.example.test/v1');
      // AGENT_FORGE_REPAIR_CODER_MODEL is unset

      const ep = loadOmniRouteRepairCoderEndpointFromEnvironment();
      expect(ep).toBeNull();
    });

    it('resolves exact coder resource without silently falling back', () => {
      const stdEp = standardCoderEndpoint();
      const repEp = repairCoderEndpoint(true, 'AVAILABLE');

      const stdAuth: ExecutionAuthorization = {
        id: 'auth-1',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        task_revision: 1,
        selected_provider_id: 'provider-external-router',
        selected_resource_id: 'coder-omniroute',
        selected_account_id: undefined,
        base_sha: shaA,
        repository_head_sha: shaA,
        manager_message_id: 'msg-1',
        manager_payload_hash: 'hash-1',
        routing_decision_id: 'route-1',
        instruction_payload_hash: 'inst-1',
        context_manifest_hash: 'manifest-1',
        canonical_instructions_json: '[]',
        context_files_json: '[]',
        canonical_payload_json: null,
        status: 'AUTHORIZED',
        created_at: new Date().toISOString(),
        dispatched_at: null,
      };

      const repAuth: ExecutionAuthorization = {
        ...stdAuth,
        id: 'auth-2',
        selected_resource_id: 'repair-coder-omniroute',
      };

      const stdBinding: CoderResourceBinding = {
        resourceId: 'coder-omniroute',
        providerId: 'provider-external-router',
        providerAccountId: null,
        adapterType: 'API',
        providerEnabled: true,
        resourceEnabled: true,
        resourceHealth: 'AVAILABLE',
        capabilities: ['CODING'],
      };

      const repBinding: CoderResourceBinding = {
        resourceId: 'repair-coder-omniroute',
        providerId: 'provider-external-router',
        providerAccountId: null,
        adapterType: 'API',
        providerEnabled: true,
        resourceEnabled: true,
        resourceHealth: 'AVAILABLE',
        capabilities: ['CODING'],
      };

      const candidates = [stdEp, repEp];

      // Standard selection routes to OMNIROUTE
      const stdSel = resolveCoderProvider(stdAuth, stdBinding, candidates, {
        providerId: 'prov-antigravity-cli',
        resourceId: 'res-antigravity-cli-coder',
      });
      expect(stdSel.provider).toBe('OMNIROUTE');

      // Repair selection routes to OMNIROUTE
      const repSel = resolveCoderProvider(repAuth, repBinding, candidates, {
        providerId: 'prov-antigravity-cli',
        resourceId: 'res-antigravity-cli-coder',
      });
      expect(repSel.provider).toBe('OMNIROUTE');

      // If repair resource is requested but repair endpoint is disabled, fail closed without falling back to standard coder!
      const disabledRepEp = repairCoderEndpoint(false, 'AVAILABLE');
      const failSel = resolveCoderProvider(repAuth, repBinding, [stdEp, disabledRepEp], {
        providerId: 'prov-antigravity-cli',
        resourceId: 'res-antigravity-cli-coder',
      });
      expect(failSel.provider).toBe('NONE');
      expect(failSel.error).toContain('AUTHORIZED_CODER_UNAVAILABLE');
    });
  });

  describe('7. Lineage Persistence & Reconstruction Across Restarts', () => {
    let tempDir: string;
    let store: AutonomyStore;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-lineage-test-'));
      store = AutonomyStore.open(tempDir).store;
    });

    afterEach(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Cleanup best effort
      }
    });

    it('persists and rebuilds complete repair lineage without data loss across restarts', () => {
      const taskId = 'TSK-PERSIST-007';

      // 1. Record Attempt 1 package
      const pkg1 = sampleRepairPackage({
        taskId,
        attempt: 1,
        baseSha: shaA,
        currentHeadSha: shaA,
        currentSnapshotSha: 'snap-attempt-1',
        reviewerFindings: [
          {
            finding_id: 'finding-101',
            severity: 'CRITICAL',
            title: 'Critical bug 1',
            description: 'NPE on empty list',
            required_action: 'Check empty list',
            evidence: '',
            acceptance_evidence: '',
          },
          {
            finding_id: 'finding-102',
            severity: 'HIGH',
            title: 'High bug 2',
            description: 'Timeout on huge file',
            required_action: 'Add streaming buffer',
            evidence: '',
            acceptance_evidence: '',
          },
        ],
        requiredActions: ['Check empty list', 'Add streaming buffer'],
      });
      store.recordRepairContext(pkg1);

      // Record Attempt 1 outcome: No progress detected
      store.recordRepairNoProgress(taskId, {
        hasNoProgress: true,
        category: 'NO_OP_WITH_UNRESOLVED_ACTIONS',
        reason: 'Zero changes produced',
      });
      store.recordRepairOutcome({
        protocol_version: 'repairoutcome.v1',
        task_id: taskId,
        attempt: 1,
        status: 'NO_PROGRESS',
        resolved_finding_ids: [],
        unresolved_finding_ids: ['finding-101', 'finding-102'],
        no_progress_category: 'NO_OP_WITH_UNRESOLVED_ACTIONS',
        escalation_stage: 'NORMAL_CODER',
        summary: 'Attempt 1 produced no progress',
        head_sha: shaA,
        snapshot_sha: 'snap-attempt-1',
        created_at: new Date().toISOString(),
      });

      // 2. Record Attempt 2 package (escalated to EXPLICIT_EVIDENCE)
      const pkg2 = sampleRepairPackage({
        taskId,
        attempt: 2,
        baseSha: shaA,
        currentHeadSha: shaA,
        currentSnapshotSha: 'snap-attempt-2',
        reviewerFindings: pkg1.previous_reviewer_findings,
        requiredActions: pkg1.required_actions,
        previousResolvedFindingIds: ['finding-101'], // finding-101 now resolved
        previousCoderActions: [
          {
            attempt: 1,
            changed_files: [],
            diff_summary: '',
            test_results: [],
            addressed_finding_ids: [],
            unresolved_finding_ids: ['finding-101', 'finding-102'],
            known_risks: [],
          },
        ],
        knownFailedApproaches: [
          {
            attempt: 1,
            description: 'Attempt 1 produced no progress',
            test_failure_signatures: [],
          },
        ],
      });
      store.recordRepairContext(pkg2);

      // Verify immediate retrieval
      const latest = store.getLatestRepairContext(taskId);
      expect(latest).not.toBeNull();
      expect(latest?.attempt).toBe(2);
      expect(latest?.escalation_stage).toBe('EXPLICIT_EVIDENCE');
      expect(latest?.resolved_finding_ids).toEqual(['finding-101']);
      expect(latest?.unresolved_finding_ids).toEqual(['finding-102']);

      // 3. Simulate process restart by opening a new store instance pointing to the same SQLite database
      const reopenedStore = AutonomyStore.open(tempDir).store;

      const lineage = reopenedStore.rebuildRepairLineage(taskId);
      expect(lineage.taskId).toBe(taskId);
      expect(lineage.latestAttempt).toBe(2);
      expect(lineage.currentSnapshotSha).toBe('snap-attempt-2');
      expect(lineage.resolvedFindingIds).toEqual(['finding-101']);
      expect(lineage.unresolvedFindingIds).toEqual(['finding-102']);
      expect(lineage.knownFailedApproaches).toHaveLength(1);
      expect(lineage.knownFailedApproaches[0].description).toBe('Attempt 1 produced no progress');
      expect(lineage.packages).toHaveLength(2);
      expect(lineage.outcomes).toHaveLength(1);
      expect(lineage.outcomes[0].status).toBe('NO_PROGRESS');
      expect(lineage.outcomes[0].no_progress_category).toBe('NO_OP_WITH_UNRESOLVED_ACTIONS');
    });

    it('reuses a repair context only when authorization, epoch, head, and routing all match', () => {
      const taskId = 'TSK-BINDING-008';
      const stale = sampleRepairPackage({
        taskId,
        authorizationId: 'auth-old',
        ownershipEpoch: 1,
        baseSha: shaA,
        currentHeadSha: shaA,
        selectedProviderId: 'provider-old',
        selectedResourceId: 'resource-old',
      });
      const current = sampleRepairPackage({
        taskId,
        attempt: 2,
        authorizationId: 'auth-current',
        ownershipEpoch: 2,
        baseSha: shaA,
        currentHeadSha: shaB,
        selectedProviderId: 'provider-current',
        selectedResourceId: 'resource-current',
      });
      store.recordRepairContext(stale);
      store.recordRepairContext(current);

      expect(store.getLatestRepairContext(taskId, {
        authorizationId: 'auth-current',
        ownershipEpoch: 2,
        baseSha: shaA,
        currentHeadSha: shaB,
        selectedProviderId: 'provider-current',
        selectedResourceId: 'resource-current',
      })).toEqual(current);

      expect(store.getLatestRepairContext(taskId, {
        authorizationId: 'auth-current',
        ownershipEpoch: 2,
        baseSha: shaA,
        currentHeadSha: shaB,
        selectedProviderId: 'provider-old',
        selectedResourceId: 'resource-old',
      })).toBeNull();
    });
  });
});
