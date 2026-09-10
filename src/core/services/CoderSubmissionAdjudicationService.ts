import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  Repository,
  CoderSubmission,
  CoderSubmissionDisposition,
} from '../database/repositories';
import {
  CoderSubmissionAdjudication,
  CoderSubmissionAdjudicationEvent,
  CanonicalAuthoritySnapshot,
  QuarantinedSubmissionSummary,
  QuarantinedSubmissionInspection,
  AdjudicationAction,
  AdjudicationStatus,
  AdjudicationEventType,
  AdjudicationFailureCode,
  CoderSubmissionAdjudicationError,
  AUTHORITY_SNAPSHOT_KEYS,
  CanonicalWorkspaceFingerprint,
  SealedVerificationExecutionInput,
  SubmissionAuthorityIntegrityResult,
  CanonicalVerificationResultEnvelope,
  CANONICAL_VERIFICATION_RESULT_ENVELOPE_KEYS,
  StagedEvidenceFile,
  VerifiedAdjudicationReviewProjection,
  VerificationExecutionObservation,
  ArtifactManifest,
  ArtifactManifestEntry,
  CoderSubmissionWorkspaceLease,
} from '../types/adjudication';
import { Evidence, GitStatusSummary, GitDiffSummary, TestRun } from '../types/domain';
import {
  ArtifactStore,
  defaultArtifactStore,
  verifyEvidenceIntegrity,
  canonicalizeArtifactManifest,
  computeArtifactManifestHash,
  parseAndVerifyArtifactManifest,
} from './ArtifactStore';
import { VerificationService } from './VerificationService';
import { EventService } from './EventService';
import { GitService } from './GitService';
import { ProcessRunner } from './ProcessRunner';
import { TaskStateMachine } from '../state/taskStateMachine';
import {
  canonicalJsonStringify,
  computeSha256,
  CLAIM_CONTENT_KEYS,
  CANONICAL_ENVELOPE_KEYS,
} from '../../mcp/submissionProtocol';
import { computePayloadHash, CanonicalExecutionPayload } from './ExecutionAuthorizationService';

export const CANONICAL_EXECUTION_PAYLOAD_EXACT_KEYS = [
  'acceptanceCriteria',
  'attemptId',
  'constraints',
  'contextFiles',
  'instructions',
  'managerMessageId',
  'managerPayloadHash',
  'projectId',
  'taskDescription',
  'taskId',
  'taskTitle',
  'verificationCommands',
] as const;

export function validateAndHashCanonicalExecutionPayload(rawJson: string): {
  valid: boolean;
  computedHash: string;
  parsed: Record<string, unknown> | null;
  error?: string;
} {
  if (!rawJson || typeof rawJson !== 'string' || rawJson.trim() === '') {
    return { valid: false, computedHash: '', parsed: null, error: 'Empty or missing canonical_payload_json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (parseErr: unknown) {
    return { valid: false, computedHash: '', parsed: null, error: 'Malformed JSON in canonical_payload_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    return { valid: false, computedHash: '', parsed: null, error: 'canonical_payload_json must be a strict plain object' };
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expectedKeys = [...CANONICAL_EXECUTION_PAYLOAD_EXACT_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
    return { valid: false, computedHash: '', parsed: null, error: 'canonical_payload_json has invalid property set (missing or extra keys)' };
  }

  // Reject snake_case aliases or empty values
  if (typeof obj.projectId !== 'string' || !obj.projectId.trim()) {
    return { valid: false, computedHash: '', parsed: null, error: 'projectId must be non-empty string' };
  }
  if (typeof obj.taskId !== 'string' || !obj.taskId.trim()) {
    return { valid: false, computedHash: '', parsed: null, error: 'taskId must be non-empty string' };
  }
  if (obj.attemptId !== null && (typeof obj.attemptId !== 'string' || !obj.attemptId.trim())) {
    return { valid: false, computedHash: '', parsed: null, error: 'attemptId must be string or null' };
  }
  if (typeof obj.taskTitle !== 'string') {
    return { valid: false, computedHash: '', parsed: null, error: 'taskTitle must be string' };
  }
  if (obj.taskDescription !== null && typeof obj.taskDescription !== 'string') {
    return { valid: false, computedHash: '', parsed: null, error: 'taskDescription must be string or null' };
  }
  if (!Array.isArray(obj.acceptanceCriteria) || !obj.acceptanceCriteria.every((c) => typeof c === 'string')) {
    return { valid: false, computedHash: '', parsed: null, error: 'acceptanceCriteria must be string array' };
  }
  if (!Array.isArray(obj.constraints) || !obj.constraints.every((c) => typeof c === 'string')) {
    return { valid: false, computedHash: '', parsed: null, error: 'constraints must be string array' };
  }
  if (!Array.isArray(obj.instructions) || !obj.instructions.every((c) => typeof c === 'string')) {
    return { valid: false, computedHash: '', parsed: null, error: 'instructions must be string array' };
  }
  if (!Array.isArray(obj.contextFiles) || !obj.contextFiles.every((c) => typeof c === 'string')) {
    return { valid: false, computedHash: '', parsed: null, error: 'contextFiles must be string array' };
  }
  if (typeof obj.managerMessageId !== 'string' || !obj.managerMessageId.trim()) {
    return { valid: false, computedHash: '', parsed: null, error: 'managerMessageId must be non-empty string' };
  }
  if (typeof obj.managerPayloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(obj.managerPayloadHash)) {
    return { valid: false, computedHash: '', parsed: null, error: 'managerPayloadHash must be 64-char hex' };
  }
  if (!obj.verificationCommands || typeof obj.verificationCommands !== 'object' || Array.isArray(obj.verificationCommands)) {
    return { valid: false, computedHash: '', parsed: null, error: 'verificationCommands must be non-null object' };
  }

  const vCmds = obj.verificationCommands as Record<string, unknown>;
  const vTest = vCmds.TEST;
  if (!vTest || typeof vTest !== 'object' || Array.isArray(vTest)) {
    return { valid: false, computedHash: '', parsed: null, error: 'verificationCommands.TEST must be non-null object' };
  }
  const testObj = vTest as Record<string, unknown>;
  if (typeof testObj.executable !== 'string' || !testObj.executable.trim()) {
    return { valid: false, computedHash: '', parsed: null, error: 'verificationCommands.TEST executable must be non-empty string' };
  }
  if (!Array.isArray(testObj.args) || !testObj.args.every((a) => typeof a === 'string')) {
    return { valid: false, computedHash: '', parsed: null, error: 'verificationCommands.TEST args must be string array' };
  }
  const tMs = testObj.timeout_ms;
  if (typeof tMs !== 'number' || !Number.isInteger(tMs) || tMs <= 0 || tMs > 600000) {
    return { valid: false, computedHash: '', parsed: null, error: 'verificationCommands.TEST timeout_ms must be a positive integer <= 600000' };
  }

  const computedHash = computePayloadHash(obj as unknown as CanonicalExecutionPayload);
  return { valid: true, computedHash, parsed: obj };
}

export function scrubAdjudicationDiagnostics(text: string): string {
  if (!text || typeof text !== 'string') return '';
  let scrubbed = text;
  // 1. Redact Windows drive paths: e.g. C:\... or d:/...
  scrubbed = scrubbed.replace(/[A-Za-z]:[\\/][^ \n\r\t,;"']+(?:[\\/][^ \n\r\t,;"']+)*/g, '[REDACTED_PATH]');
  // 2. Redact Unix paths: e.g. /home/... /usr/... /tmp/...
  scrubbed = scrubbed.replace(/(?:^|[\s,;("'])\/(?:usr|home|etc|var|tmp|opt|root|bin|proc|sys)[^\s,;)"']*/g, ' [REDACTED_PATH]');
  // 3. Redact SQL statements
  scrubbed = scrubbed.replace(/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b[\s\S]*?(?:;|\n|$)/gi, '[REDACTED_SQL]');
  // 4. Redact tokens, Bearer headers, sensitive secrets
  scrubbed = scrubbed.replace(/\baf-[a-zA-Z0-9_\-]+\b/gi, '[REDACTED_TOKEN]');
  scrubbed = scrubbed.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED_SECRET]');
  scrubbed = scrubbed.replace(/\b(?:token|token_hash|secret|password|api_key)\s*[:= ]\s*['"]?[A-Za-z0-9_\-\.]+['"]?/gi, '[REDACTED_SECRET]');
  // 5. Redact stack traces (lines starting with at ...)
  scrubbed = scrubbed.replace(/\n\s*at\s+[^\n]+/g, '\n[STACK_TRACE_REDACTED]');
  return scrubbed.trim();
}

export function deriveDeterministicAdjudicationId(submissionId: string, requestId: string): string {
  const hash = crypto.createHash('sha256').update(`agentforge:adjudication:v1:${submissionId}:${requestId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

export function deriveDeterministicAdjudicationEventId(
  adjudicationId: string,
  lifecycleVersion: number,
  eventType: string,
  payloadHash: string
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`agentforge:adjudication-lifecycle-event:v1:${adjudicationId}:${lifecycleVersion}:${eventType}:${payloadHash}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

export function deriveDeterministicGenericAdjudicationEventId(
  adjudicationId: string,
  lifecycleVersion: number,
  eventType: string,
  payloadHash: string
): string {
  const digest = computeSha256(
    `agentforge:adjudication-generic-event:v1:${adjudicationId}:${lifecycleVersion}:${eventType}:${payloadHash}`
  );
  return `evt-adj-${digest.slice(0, 32)}`;
}

export function deriveDeterministicDispositionId(
  submissionId: string,
  adjudicationId: string,
  lifecycleVersion: number
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`agentforge:coder-submission-disposition:v1:${submissionId}:${adjudicationId}:${lifecycleVersion}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

export function isCanonicalUtcIso(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch (err: unknown) {
    void err;
    return false;
  }
}

export function extractFailureDetailFromPayload(
  payload: Record<string, unknown> | null,
  defaultDetail: string
): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (typeof payload.reason === 'string' && payload.reason.trim()) {
      return payload.reason.trim();
    }
  }
  return defaultDetail;
}

export const SUPPORTED_FAILURE_CODES = [
  'PROCESS_START_FAILED',
  'TEST_FAILED',
  'TESTS_FAILED',
  'TEST_TIMEOUT',
  'VERIFICATION_TIMEOUT',
  'COMMAND_POLICY_REJECTED',
  'POLICY_VIOLATION',
  'WORKTREE_DRIFT',
  'EVIDENCE_CAPTURE_FAILED',
  'ORPHANED_VERIFICATION_INTERRUPTED',
  'ORPHANED_VERIFICATION_CANCELLED',
  'PRECONDITION_FAILED',
  'INTEGRITY_MISMATCH',
  'COMMAND_CONFIG_MISSING',
  'RECOVERY_FENCED',
  'RECOVERY_ACKNOWLEDGED',
  'POST_COMMIT_FINALIZATION_UNCERTAINTY',
  'PROCESS_TERMINATION_UNRESOLVED',
  'CLEANUP_DEBT_FENCED',
] as const;
export type SupportedFailureCode = (typeof SUPPORTED_FAILURE_CODES)[number];

export const FENCED_FAILURE_CODES = new Set<SupportedFailureCode>([
  'ORPHANED_VERIFICATION_INTERRUPTED',
  'ORPHANED_VERIFICATION_CANCELLED',
  'PROCESS_TERMINATION_UNRESOLVED',
  'EVIDENCE_CAPTURE_FAILED',
  'RECOVERY_FENCED',
  'CLEANUP_DEBT_FENCED',
]);

export const POLICY_FAILURE_CODES = new Set<SupportedFailureCode>([
  'COMMAND_POLICY_REJECTED',
  'POLICY_VIOLATION',
]);

export function validateAndParseCanonicalResultEnvelope(
  rawJson: string,
  expectedHash?: string
): {
  valid: boolean;
  envelope: CanonicalVerificationResultEnvelope | null;
  error?: string;
} {
  if (!rawJson || typeof rawJson !== 'string' || rawJson.trim() === '') {
    return { valid: false, envelope: null, error: 'Empty or missing result envelope JSON' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (parseErr: unknown) {
    void parseErr;
    return { valid: false, envelope: null, error: 'Malformed JSON in verification result envelope' };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return { valid: false, envelope: null, error: 'Verification result envelope must be a strict plain object' };
  }

  const obj = parsed as Record<string, unknown>;
  const actualKeys = Object.keys(obj).sort();
  const expectedKeys = [...CANONICAL_VERIFICATION_RESULT_ENVELOPE_KEYS].sort();

  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((k, i) => k !== expectedKeys[i])
  ) {
    return { valid: false, envelope: null, error: 'Verification result envelope property set mismatch (missing or extra keys)' };
  }

  // Canonical JSON byte equality check
  const canonicalForm = canonicalJsonStringify(obj);
  if (canonicalForm !== rawJson) {
    return { valid: false, envelope: null, error: 'Verification result envelope is not byte-identical to its canonical JSON representation' };
  }

  // SHA-256 hash recomputation and format validation
  const computedHash = computeSha256(rawJson);
  if (expectedHash !== undefined) {
    if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
      return { valid: false, envelope: null, error: 'expectedHash must be a 64-char lowercase hex string' };
    }
    if (computedHash !== expectedHash) {
      return { valid: false, envelope: null, error: `Verification result envelope hash mismatch: expected ${expectedHash}, got ${computedHash}` };
    }
  }

  // Exact field domain validations
  if (typeof obj.adjudication_id !== 'string' || !obj.adjudication_id.trim()) {
    return { valid: false, envelope: null, error: 'adjudication_id must be non-empty string' };
  }
  if (typeof obj.project_id !== 'string' || !obj.project_id.trim()) {
    return { valid: false, envelope: null, error: 'project_id must be non-empty string' };
  }
  if (typeof obj.task_id !== 'string' || !obj.task_id.trim()) {
    return { valid: false, envelope: null, error: 'task_id must be non-empty string' };
  }
  if (obj.attempt_id !== null && (typeof obj.attempt_id !== 'string' || !obj.attempt_id.trim())) {
    return { valid: false, envelope: null, error: 'attempt_id must be string or null' };
  }
  if (typeof obj.assignment_id !== 'string' || !obj.assignment_id.trim()) {
    return { valid: false, envelope: null, error: 'assignment_id must be non-empty string' };
  }
  if (typeof obj.authorization_id !== 'string' || !obj.authorization_id.trim()) {
    return { valid: false, envelope: null, error: 'authorization_id must be non-empty string' };
  }
  if (typeof obj.task_ownership_epoch !== 'number' || !Number.isInteger(obj.task_ownership_epoch) || obj.task_ownership_epoch <= 0) {
    return { valid: false, envelope: null, error: 'task_ownership_epoch must be an integer strictly greater than zero' };
  }
  if (typeof obj.lifecycle_version !== 'number' || !Number.isInteger(obj.lifecycle_version) || obj.lifecycle_version <= 0) {
    return { valid: false, envelope: null, error: 'lifecycle_version must be positive integer' };
  }
  if (obj.lifecycle_version !== 3) {
    return { valid: false, envelope: null, error: 'lifecycle_version must be integer 3' };
  }
  if (typeof obj.verification_execution_id !== 'string' || !obj.verification_execution_id.trim()) {
    return { valid: false, envelope: null, error: 'verification_execution_id must be non-empty string' };
  }
  if (typeof obj.command_snapshot_hash !== 'string' || !/^[0-9a-f]{64}$/.test(obj.command_snapshot_hash)) {
    return { valid: false, envelope: null, error: 'command_snapshot_hash must be a 64-char lowercase hex string' };
  }
  if (typeof obj.workspace_snapshot_before_hash !== 'string' || !/^[0-9a-f]{64}$/.test(obj.workspace_snapshot_before_hash)) {
    return { valid: false, envelope: null, error: 'workspace_snapshot_before_hash must be a 64-char lowercase hex string' };
  }
  if (typeof obj.workspace_snapshot_after_hash !== 'string' || !/^[0-9a-f]{64}$/.test(obj.workspace_snapshot_after_hash)) {
    return { valid: false, envelope: null, error: 'workspace_snapshot_after_hash must be a 64-char lowercase hex string' };
  }
  if (typeof obj.artifact_manifest_hash !== 'string' || !/^[0-9a-f]{64}$/.test(obj.artifact_manifest_hash)) {
    return { valid: false, envelope: null, error: 'artifact_manifest_hash must be a 64-char lowercase hex string' };
  }
  if (!isCanonicalUtcIso(obj.start_timestamp)) {
    return { valid: false, envelope: null, error: 'start_timestamp must be canonical UTC ISO-8601 string' };
  }
  if (!isCanonicalUtcIso(obj.finish_timestamp)) {
    return { valid: false, envelope: null, error: 'finish_timestamp must be canonical UTC ISO-8601 string' };
  }
  if (Date.parse(obj.finish_timestamp as string) < Date.parse(obj.start_timestamp as string)) {
    return { valid: false, envelope: null, error: 'finish_timestamp must be monotonically >= start_timestamp' };
  }

  const validExit = ['EXIT_ZERO', 'EXIT_NONZERO', 'NONZERO_EXIT', 'TIMEOUT', 'CANCELLED', 'UNKNOWN', 'PROCESS_START_FAILED', 'OUTPUT_LIMIT_EXCEEDED'];
  if (typeof obj.exit_classification !== 'string' || !validExit.includes(obj.exit_classification)) {
    return { valid: false, envelope: null, error: `Invalid exit_classification: ${obj.exit_classification}` };
  }

  const validTerm = ['TERMINATION_PROVEN', 'TERMINATION_AMBIGUOUS', 'NOT_APPLICABLE'];
  if (typeof obj.termination_classification !== 'string' || !validTerm.includes(obj.termination_classification)) {
    return { valid: false, envelope: null, error: `Invalid termination_classification: ${obj.termination_classification}` };
  }

  const validStart = ['SPAWNED_PROVEN', 'LAUNCH_FAILED_PROVEN', 'NOT_STARTED_PROVEN', 'LAUNCH_AMBIGUOUS'];
  if (typeof obj.process_start_classification !== 'string' || !validStart.includes(obj.process_start_classification)) {
    return { valid: false, envelope: null, error: `Invalid process_start_classification: ${obj.process_start_classification}` };
  }

  // Optional evidence ID/hash closed domain validation
  const hasGitDiffId = typeof obj.git_diff_evidence_id === 'string' && obj.git_diff_evidence_id.trim() !== '';
  const hasGitDiffHash = typeof obj.git_diff_evidence_hash === 'string' && obj.git_diff_evidence_hash.trim() !== '';
  if (hasGitDiffId !== hasGitDiffHash) {
    return { valid: false, envelope: null, error: 'git_diff_evidence_id and git_diff_evidence_hash must be both present or both empty' };
  }
  if (hasGitDiffHash && !/^[0-9a-f]{64}$/.test(obj.git_diff_evidence_hash as string)) {
    return { valid: false, envelope: null, error: 'git_diff_evidence_hash must be a 64-char lowercase hex string when present' };
  }
  if (!hasGitDiffId && obj.git_diff_evidence_id !== '') {
    return { valid: false, envelope: null, error: 'git_diff_evidence_id must be empty string when diff evidence is absent' };
  }
  if (!hasGitDiffHash && obj.git_diff_evidence_hash !== '') {
    return { valid: false, envelope: null, error: 'git_diff_evidence_hash must be empty string when diff evidence is absent' };
  }

  const hasGitStatusId = typeof obj.git_status_evidence_id === 'string' && obj.git_status_evidence_id.trim() !== '';
  const hasGitStatusHash = typeof obj.git_status_evidence_hash === 'string' && obj.git_status_evidence_hash.trim() !== '';
  if (hasGitStatusId !== hasGitStatusHash) {
    return { valid: false, envelope: null, error: 'git_status_evidence_id and git_status_evidence_hash must be both present or both empty' };
  }
  if (hasGitStatusHash && !/^[0-9a-f]{64}$/.test(obj.git_status_evidence_hash as string)) {
    return { valid: false, envelope: null, error: 'git_status_evidence_hash must be a 64-char lowercase hex string when present' };
  }
  if (!hasGitStatusId && obj.git_status_evidence_id !== '') {
    return { valid: false, envelope: null, error: 'git_status_evidence_id must be empty string when status evidence is absent' };
  }
  if (!hasGitStatusHash && obj.git_status_evidence_hash !== '') {
    return { valid: false, envelope: null, error: 'git_status_evidence_hash must be empty string when status evidence is absent' };
  }

  if (typeof obj.test_result_evidence_hash !== 'string' || !/^[0-9a-f]{64}$/.test(obj.test_result_evidence_hash)) {
    return { valid: false, envelope: null, error: 'test_result_evidence_hash must be a 64-char lowercase hex string' };
  }
  if (typeof obj.test_result_evidence_id !== 'string' || !obj.test_result_evidence_id.trim()) {
    return { valid: false, envelope: null, error: 'test_result_evidence_id must be non-empty string' };
  }
  if (typeof obj.test_run_id !== 'string' || !obj.test_run_id.trim()) {
    return { valid: false, envelope: null, error: 'test_run_id must be non-empty string' };
  }

  if (obj.exit_classification === 'EXIT_ZERO') {
    if (obj.failure_code !== null) {
      return { valid: false, envelope: null, error: 'failure_code must be null when exit_classification is EXIT_ZERO' };
    }
    if (obj.failure_payload !== null) {
      return { valid: false, envelope: null, error: 'failure_payload must be null when failure_code is null' };
    }
  } else {
    if (obj.failure_code === null) {
      return { valid: false, envelope: null, error: 'failure_code must be non-null when exit_classification is not EXIT_ZERO' };
    }
  }

  // Discriminated failure payload validation
  if (obj.failure_code === null) {
    if (obj.failure_payload !== null) {
      return { valid: false, envelope: null, error: 'failure_payload must be null when failure_code is null' };
    }
  } else if (typeof obj.failure_code === 'string' && obj.failure_code.trim()) {
    const code = obj.failure_code.trim() as SupportedFailureCode;
    if (!(SUPPORTED_FAILURE_CODES as readonly string[]).includes(code)) {
      return { valid: false, envelope: null, error: `failure_code "${obj.failure_code}" is not a supported canonical failure_code` };
    }
    if (
      obj.failure_payload === null ||
      typeof obj.failure_payload !== 'object' ||
      Array.isArray(obj.failure_payload) ||
      Object.getPrototypeOf(obj.failure_payload) !== Object.prototype
    ) {
      return { valid: false, envelope: null, error: 'failure_payload must be non-null when failure_code is non-null' };
    }
    const payload = obj.failure_payload as Record<string, unknown>;
    const payloadKeys = Object.keys(payload).sort();

    if (FENCED_FAILURE_CODES.has(code) || (code === 'PROCESS_START_FAILED' && 'is_fenced' in payload)) {
      // Must have is_fenced: true and error or reason
      if (!('is_fenced' in payload) || payload.is_fenced !== true) {
        return { valid: false, envelope: null, error: `failure_payload for fenced code ${code} must have is_fenced: true` };
      }
      const allowedFencedKeys = new Set(['error', 'reason', 'is_fenced']);
      for (const k of payloadKeys) {
        if (!allowedFencedKeys.has(k)) {
          return { valid: false, envelope: null, error: `failure_payload contains unrecognized key or unauthorized extra field: "${k}"` };
        }
      }
      const msg = payload.error ?? payload.reason;
      if (typeof msg !== 'string' || !msg.trim() || msg.length > 4096) {
        return { valid: false, envelope: null, error: 'failure_payload error/reason must be a non-empty string <= 4096 characters' };
      }
    } else {
      // Non-fenced: is_fenced is strictly forbidden (contradictory)
      if ('is_fenced' in payload) {
        return {
          valid: false,
          envelope: null,
          error: `failure_payload for non-fenced code ${code} must not include is_fenced`,
        };
      }
      const allowedNonFencedKeys = new Set(['error', 'reason', 'failed_tests_count']);
      for (const k of payloadKeys) {
        if (!allowedNonFencedKeys.has(k)) {
          return { valid: false, envelope: null, error: `failure_payload contains unrecognized key or unauthorized extra field: "${k}"` };
        }
      }
      if ('failed_tests_count' in payload) {
        if (typeof payload.failed_tests_count !== 'number' || !Number.isInteger(payload.failed_tests_count) || payload.failed_tests_count < 0) {
          return { valid: false, envelope: null, error: 'failure_payload.failed_tests_count must be a non-negative integer' };
        }
      }
      if ('error' in payload || 'reason' in payload) {
        const msg = (payload.error ?? payload.reason) as unknown;
        if (typeof msg !== 'string' || !msg.trim() || msg.length > 4096) {
          return { valid: false, envelope: null, error: 'failure_payload error/reason must be a non-empty string <= 4096 characters' };
        }
      }
      if (payloadKeys.length === 0) {
        return { valid: false, envelope: null, error: `failure_payload for code ${code} must contain at least one valid field` };
      }
    }
  } else {
    return { valid: false, envelope: null, error: 'failure_code must be non-empty string or null' };
  }

  return { valid: true, envelope: obj as unknown as CanonicalVerificationResultEnvelope };
}

export interface CanonicalSettlementEvaluationInput {
  rawEnvelopeJson: string;
  storedEnvelopeHash: string;
  rawManifestJson: string;
  storedManifestHash: string;
  adjudication: CoderSubmissionAdjudication;
  testRun: TestRun;
  gitStatusEvidenceId: string | null;
  gitDiffEvidenceId: string | null;
  testResultEvidenceId: string;
  repo: Repository;
  artifactStore: ArtifactStore;
}

export interface CanonicalSettlementDecision {
  valid: boolean;
  isSuccess: boolean;
  targetStatus: 'VERIFIED' | 'VERIFICATION_FAILED' | 'RECOVERY_FENCED';
  taskTransition: 'REVIEW_READY' | 'NEEDS_HUMAN';
  eventType: 'VERIFICATION_SUCCEEDED' | 'VERIFICATION_FAILED' | 'RECOVERY_FENCED';
  dispositionEvent: 'SETTLED' | 'REJECTED';
  dispositionReason: 'ACCEPTED_VERIFIED' | 'VERIFICATION_FAILED' | 'RECOVERY_FENCED';
  failureCode: string | null;
  failureDetail: string | null;
  contradictionReason?: string;
}

export function evaluateCanonicalSettlementDecision(
  input: CanonicalSettlementEvaluationInput
): CanonicalSettlementDecision {
  // Fail-closed hash validation before consuming any domain field
  if (typeof input.storedEnvelopeHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.storedEnvelopeHash)) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'storedEnvelopeHash must be a 64-char lowercase hex string',
      contradictionReason: 'storedEnvelopeHash invalid',
    };
  }

  if (typeof input.storedManifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.storedManifestHash)) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'storedManifestHash must be a 64-char lowercase hex string',
      contradictionReason: 'storedManifestHash invalid',
    };
  }

  if (typeof input.rawEnvelopeJson !== 'string' || !input.rawEnvelopeJson.trim()) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'rawEnvelopeJson must be non-empty string',
      contradictionReason: 'rawEnvelopeJson missing',
    };
  }

  if (typeof input.rawManifestJson !== 'string' || !input.rawManifestJson.trim()) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'rawManifestJson must be non-empty string',
      contradictionReason: 'rawManifestJson missing',
    };
  }

  if (computeSha256(input.rawEnvelopeJson) !== input.storedEnvelopeHash) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'rawEnvelopeJson SHA-256 does not match storedEnvelopeHash',
      contradictionReason: 'Envelope hash mismatch',
    };
  }

  if (computeSha256(input.rawManifestJson) !== input.storedManifestHash) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'rawManifestJson SHA-256 does not match storedManifestHash',
      contradictionReason: 'Manifest hash mismatch',
    };
  }

  // Parse raw canonical envelope
  const parseRes = validateAndParseCanonicalResultEnvelope(input.rawEnvelopeJson, input.storedEnvelopeHash);
  if (!parseRes.valid || !parseRes.envelope) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: parseRes.error || 'Verification result envelope validation failed',
      contradictionReason: parseRes.error || 'Envelope validation failed',
    };
  }
  const envelope = parseRes.envelope;

  // Internal envelope contradiction checks
  if (envelope.exit_classification === 'EXIT_ZERO') {
    if (envelope.failure_code !== null) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Contradiction: exit_classification is EXIT_ZERO but failure_code is "${envelope.failure_code}"`,
        contradictionReason: 'EXIT_ZERO with failure_code',
      };
    }
    if (envelope.termination_classification !== 'TERMINATION_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but termination_classification is not TERMINATION_PROVEN',
        contradictionReason: 'EXIT_ZERO with unproven termination',
      };
    }
    if (envelope.process_start_classification !== 'SPAWNED_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but process_start_classification is not SPAWNED_PROVEN',
        contradictionReason: 'EXIT_ZERO with unproven start',
      };
    }
  } else {
    if (envelope.failure_code === null) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Contradiction: exit_classification is ${envelope.exit_classification} but failure_code is null`,
        contradictionReason: 'Non-zero exit with null failure_code',
      };
    }
  }


  // Parse and verify raw manifest
  let parsedManifest: ArtifactManifest;
  try {
    parsedManifest = parseAndVerifyArtifactManifest(input.rawManifestJson, input.storedManifestHash);
  } catch (mParseErr: unknown) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: `Artifact manifest parsing failed: ${mParseErr instanceof Error ? mParseErr.message : String(mParseErr)}`,
      contradictionReason: 'Artifact manifest parsing failed',
    };
  }

  if (envelope.artifact_manifest_hash !== input.storedManifestHash) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope artifact_manifest_hash mismatch stored manifest hash',
      contradictionReason: 'Artifact manifest hash mismatch',
    };
  }

  if (parsedManifest.adjudication_id !== input.adjudication.id) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Manifest adjudication_id mismatch',
      contradictionReason: 'Manifest adjudication_id mismatch',
    };
  }

  // Validate binding consistency with adjudication
  if (
    envelope.adjudication_id !== input.adjudication.id ||
    envelope.project_id !== input.adjudication.project_id ||
    envelope.task_id !== input.adjudication.task_id ||
    envelope.attempt_id !== input.adjudication.attempt_id ||
    envelope.assignment_id !== input.adjudication.assignment_id ||
    envelope.authorization_id !== input.adjudication.authorization_id ||
    envelope.task_ownership_epoch !== input.adjudication.task_ownership_epoch ||
    (input.adjudication.verification_execution_id && envelope.verification_execution_id !== input.adjudication.verification_execution_id)
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope bindings mismatch adjudication record',
      contradictionReason: 'Envelope adjudication binding mismatch',
    };
  }

  if (
    !envelope.command_snapshot_hash ||
    envelope.command_snapshot_hash !== input.adjudication.verification_commands_hash
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope command_snapshot_hash mismatch adjudication verification_commands_hash',
      contradictionReason: 'Command snapshot hash mismatch',
    };
  }

  if (envelope.lifecycle_version !== 3) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope lifecycle_version must be 3',
      contradictionReason: 'lifecycle_version mismatch',
    };
  }

  // Validate workspace before & after snapshot bindings to durable authoritative state
  if (
    !input.adjudication.workspace_snapshot_before_hash ||
    envelope.workspace_snapshot_before_hash !== input.adjudication.workspace_snapshot_before_hash
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope workspace_snapshot_before_hash mismatch adjudication durable snapshot before hash',
      contradictionReason: 'workspace_snapshot_before_hash mismatch',
    };
  }

  if (!envelope.workspace_snapshot_after_hash || !/^[0-9a-f]{64}$/.test(envelope.workspace_snapshot_after_hash)) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope workspace_snapshot_after_hash must be a 64-char lowercase hex string',
      contradictionReason: 'workspace_snapshot_after_hash invalid',
    };
  }

  // Bind workspace_snapshot_after_hash to durable captured evidence in repo
  const taskEvidenceList = input.repo.getEvidenceByTask(input.adjudication.task_id);
  const matchingAfterEvidence = taskEvidenceList.find(
    (ev) => ev.hash === envelope.workspace_snapshot_after_hash
  );
  if (!matchingAfterEvidence) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope workspace_snapshot_after_hash is not backed by durable captured evidence',
      contradictionReason: 'workspace_snapshot_after_hash not backed by durable evidence',
    };
  }

  // 1-to-1 set equality between manifest entries and all envelope evidence bindings
  const expectedEvidenceIds = new Set<string>();
  expectedEvidenceIds.add(envelope.test_result_evidence_id);
  if (envelope.git_status_evidence_id) expectedEvidenceIds.add(envelope.git_status_evidence_id);
  if (envelope.git_diff_evidence_id) expectedEvidenceIds.add(envelope.git_diff_evidence_id);

  const manifestMap = new Map<string, ArtifactManifestEntry>();
  for (const entry of parsedManifest.entries) {
    if (!entry.evidence_id || !entry.sha256 || !entry.relative_path) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Manifest entry missing required fields',
        contradictionReason: 'Manifest entry invalid',
      };
    }
    if (manifestMap.has(entry.evidence_id)) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Duplicate evidence_id "${entry.evidence_id}" in manifest entries`,
        contradictionReason: 'Duplicate manifest evidence_id',
      };
    }
    manifestMap.set(entry.evidence_id, entry);
  }

  if (
    manifestMap.size !== expectedEvidenceIds.size ||
    [...expectedEvidenceIds].some((id) => !manifestMap.has(id))
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Manifest entries and envelope evidence bindings do not have 1:1 set equality',
      contradictionReason: 'Manifest entry set equality mismatch',
    };
  }

  // Validate each manifest entry against its durable evidence row and disk
  for (const entry of parsedManifest.entries) {
    const ev = input.repo.getEvidence(entry.evidence_id);
    if (!ev) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} missing in database`,
        contradictionReason: 'Manifest entry evidence mismatch',
      };
    }
    if (ev.project_id !== input.adjudication.project_id) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} project_id mismatch: expected ${input.adjudication.project_id}, got ${ev.project_id}`,
        contradictionReason: 'Manifest entry evidence project mismatch',
      };
    }
    if (ev.task_id !== input.adjudication.task_id) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} task_id mismatch: expected ${input.adjudication.task_id}, got ${ev.task_id}`,
        contradictionReason: 'Manifest entry evidence task mismatch',
      };
    }
    if (input.adjudication.attempt_id && ev.attempt_id !== input.adjudication.attempt_id) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} attempt_id mismatch: expected ${input.adjudication.attempt_id}, got ${ev.attempt_id}`,
        contradictionReason: 'Manifest entry evidence attempt mismatch',
      };
    }
    if (ev.evidence_type !== entry.evidence_type) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} evidence_type mismatch: expected ${entry.evidence_type}, got ${ev.evidence_type}`,
        contradictionReason: 'Manifest entry evidence type mismatch',
      };
    }
    if (ev.storage_type !== entry.storage_class) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} storage_class mismatch: expected ${entry.storage_class}, got ${ev.storage_type}`,
        contradictionReason: 'Manifest entry storage class mismatch',
      };
    }
    if (ev.content_type !== entry.content_type) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} content_type mismatch: expected ${entry.content_type}, got ${ev.content_type}`,
        contradictionReason: 'Manifest entry content type mismatch',
      };
    }
    if (ev.byte_size !== entry.byte_size) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} byte_size mismatch: expected ${entry.byte_size}, got ${ev.byte_size}`,
        contradictionReason: 'Manifest entry byte size mismatch',
      };
    }
    if (ev.hash !== entry.sha256) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} sha256 mismatch: expected ${entry.sha256}, got ${ev.hash}`,
        contradictionReason: 'Manifest entry hash mismatch',
      };
    }
    const integ = verifyEvidenceIntegrity(ev, input.artifactStore);
    if (!integ.valid) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Manifest entry evidence ${entry.evidence_id} disk integrity verification failed: ${integ.reason}`,
        contradictionReason: 'Manifest entry disk integrity failed',
      };
    }
  }

  // Bind each git/test evidence ID and hash in envelope to matching durable row and manifest entry
  const trManifest = manifestMap.get(envelope.test_result_evidence_id);
  if (!trManifest || trManifest.sha256 !== envelope.test_result_evidence_hash) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope test_result_evidence_id and hash do not match manifest entry',
      contradictionReason: 'test_result_evidence manifest binding mismatch',
    };
  }
  const trRow = input.repo.getEvidence(envelope.test_result_evidence_id);
  if (!trRow || trRow.hash !== envelope.test_result_evidence_hash) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope test_result_evidence_id and hash do not match durable evidence row',
      contradictionReason: 'test_result_evidence durable binding mismatch',
    };
  }

  if (envelope.git_status_evidence_id) {
    const gsManifest = manifestMap.get(envelope.git_status_evidence_id);
    if (!gsManifest || gsManifest.sha256 !== envelope.git_status_evidence_hash) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope git_status_evidence_id and hash do not match manifest entry',
        contradictionReason: 'git_status_evidence manifest binding mismatch',
      };
    }
    const gsRow = input.repo.getEvidence(envelope.git_status_evidence_id);
    if (!gsRow || gsRow.hash !== envelope.git_status_evidence_hash) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope git_status_evidence_id and hash do not match durable evidence row',
        contradictionReason: 'git_status_evidence durable binding mismatch',
      };
    }
  }

  if (envelope.git_diff_evidence_id) {
    const gdManifest = manifestMap.get(envelope.git_diff_evidence_id);
    if (!gdManifest || gdManifest.sha256 !== envelope.git_diff_evidence_hash) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope git_diff_evidence_id and hash do not match manifest entry',
        contradictionReason: 'git_diff_evidence manifest binding mismatch',
      };
    }
    const gdRow = input.repo.getEvidence(envelope.git_diff_evidence_id);
    if (!gdRow || gdRow.hash !== envelope.git_diff_evidence_hash) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope git_diff_evidence_id and hash do not match durable evidence row',
        contradictionReason: 'git_diff_evidence durable binding mismatch',
      };
    }
  }

  // Caller evidence ID consistency check
  if ((envelope.git_status_evidence_id || null) !== (input.gitStatusEvidenceId || null)) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope git_status_evidence_id mismatch caller expected ID',
      contradictionReason: 'git_status_evidence_id mismatch',
    };
  }
  if ((envelope.git_diff_evidence_id || null) !== (input.gitDiffEvidenceId || null)) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope git_diff_evidence_id mismatch caller expected ID',
      contradictionReason: 'git_diff_evidence_id mismatch',
    };
  }
  if (envelope.test_result_evidence_id !== input.testResultEvidenceId) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope test_result_evidence_id mismatch caller expected ID',
      contradictionReason: 'test_result_evidence_id mismatch',
    };
  }

  // Test run consistency check
  if (envelope.test_run_id !== input.testRun.id) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope test_run_id mismatch test run record',
      contradictionReason: 'test_run_id mismatch',
    };
  }
  if (input.testRun.evidence_id !== envelope.test_result_evidence_id) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Test run evidence_id mismatch envelope test_result_evidence_id',
      contradictionReason: 'test_run evidence_id mismatch',
    };
  }
  if (envelope.exit_classification === 'EXIT_ZERO' && input.testRun.exit_code !== 0) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: `Test run exit code ${input.testRun.exit_code} contradicts envelope EXIT_ZERO`,
      contradictionReason: 'exit_code non-zero with EXIT_ZERO',
    };
  }
  if (envelope.exit_classification !== 'EXIT_ZERO' && input.testRun.exit_code === 0) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: `Test run exit code 0 contradicts envelope ${envelope.exit_classification}`,
      contradictionReason: 'exit_code zero with non-zero classification',
    };
  }

  // Internal envelope contradiction checks
  if (envelope.exit_classification === 'EXIT_ZERO') {
    if (envelope.failure_code !== null) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Contradiction: exit_classification is EXIT_ZERO but failure_code is "${envelope.failure_code}"`,
        contradictionReason: 'EXIT_ZERO with failure_code',
      };
    }
    if (envelope.termination_classification !== 'TERMINATION_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but termination_classification is not TERMINATION_PROVEN',
        contradictionReason: 'EXIT_ZERO with unproven termination',
      };
    }
    if (envelope.process_start_classification !== 'SPAWNED_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but process_start_classification is not SPAWNED_PROVEN',
        contradictionReason: 'EXIT_ZERO with unspawned process',
      };
    }
  }

  // Determine settlement decision
  const isCleanSuccess =
    envelope.exit_classification === 'EXIT_ZERO' &&
    envelope.failure_code === null &&
    envelope.process_start_classification === 'SPAWNED_PROVEN' &&
    envelope.termination_classification === 'TERMINATION_PROVEN' &&
    input.testRun.exit_code === 0;

  if (isCleanSuccess) {
    return {
      valid: true,
      isSuccess: true,
      targetStatus: 'VERIFIED',
      taskTransition: 'REVIEW_READY',
      eventType: 'VERIFICATION_SUCCEEDED',
      dispositionEvent: 'SETTLED',
      dispositionReason: 'ACCEPTED_VERIFIED',
      failureCode: null,
      failureDetail: null,
    };
  }

  // Handle failure classifications
  const isFencedCode =
    envelope.failure_code === 'ORPHANED_VERIFICATION_INTERRUPTED' ||
    envelope.failure_code === 'ORPHANED_VERIFICATION_CANCELLED' ||
    envelope.failure_code === 'EVIDENCE_CAPTURE_FAILED' ||
    envelope.failure_code === 'INTEGRITY_MISMATCH' ||
    envelope.failure_code === 'RECOVERY_FENCED' ||
    envelope.failure_code === 'CLEANUP_DEBT_FENCED' ||
    envelope.failure_code === 'PROCESS_TERMINATION_UNRESOLVED' ||
    envelope.termination_classification === 'TERMINATION_AMBIGUOUS' ||
    envelope.process_start_classification === 'LAUNCH_FAILED_PROVEN' ||
    Boolean(envelope.failure_payload?.is_fenced);

  if (isFencedCode) {
    return {
      valid: true,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: envelope.failure_code || 'INTEGRITY_MISMATCH',
      failureDetail: extractFailureDetailFromPayload(envelope.failure_payload, envelope.failure_code || 'Process execution ambiguous'),
    };
  }

  return {
    valid: true,
    isSuccess: false,
    targetStatus: 'VERIFICATION_FAILED',
    taskTransition: 'NEEDS_HUMAN',
    eventType: 'VERIFICATION_FAILED',
    dispositionEvent: 'REJECTED',
    dispositionReason: 'VERIFICATION_FAILED',
    failureCode: envelope.failure_code || (envelope.exit_classification === 'TIMEOUT' ? 'VERIFICATION_TIMEOUT' : 'TESTS_FAILED'),
    failureDetail: extractFailureDetailFromPayload(envelope.failure_payload, `Verification failed: ${envelope.exit_classification}`),
  };
}

export interface NonAuthoritativeSettlementEvaluationInput {
  envelope: CanonicalVerificationResultEnvelope;
  rawEnvelopeJson?: string;
  expectedEnvelopeHash?: string;
  adjudication: CoderSubmissionAdjudication;
  testRun: TestRun | null;
  manifest: ArtifactManifest | null;
  rawManifestJson?: string;
  expectedManifestHash?: string;
  gitStatusEvidenceId?: string | null;
  gitDiffEvidenceId?: string | null;
  testResultEvidenceId?: string | null;
  repo?: Repository;
  artifactStore?: ArtifactStore;
}

export function evaluateNonAuthoritativeSettlementDecisionForTests(
  input: NonAuthoritativeSettlementEvaluationInput
): CanonicalSettlementDecision {
  const {
    envelope: rawEnvelopeInput,
    rawEnvelopeJson,
    expectedEnvelopeHash,
    adjudication,
    testRun,
    manifest,
    rawManifestJson,
    expectedManifestHash,
    gitStatusEvidenceId,
    gitDiffEvidenceId,
    testResultEvidenceId,
    repo,
    artifactStore,
  } = input;

  let envelope = rawEnvelopeInput;
  if (rawEnvelopeJson !== undefined) {
    const effectiveExpectedEnvelopeHash = expectedEnvelopeHash ?? computeSha256(rawEnvelopeJson);
    const parseRes = validateAndParseCanonicalResultEnvelope(rawEnvelopeJson, effectiveExpectedEnvelopeHash);
    if (!parseRes.valid || !parseRes.envelope) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: parseRes.error || 'Verification result envelope validation failed',
        contradictionReason: parseRes.error || 'Envelope validation failed',
      };
    }
    envelope = parseRes.envelope;
  }

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Verification result envelope is missing or not a plain object',
      contradictionReason: 'Envelope not a plain object',
    };
  }

  const envKeys = Object.keys(envelope).sort();
  const expectedKeys = [...CANONICAL_VERIFICATION_RESULT_ENVELOPE_KEYS].sort();
  if (envKeys.length !== expectedKeys.length || envKeys.some((k, i) => k !== expectedKeys[i])) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Verification result envelope key set mismatch',
      contradictionReason: 'Envelope key set mismatch',
    };
  }

  // Internal envelope contradiction checks
  if (envelope.exit_classification === 'EXIT_ZERO') {
    if (envelope.failure_code !== null) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Contradiction: exit_classification is EXIT_ZERO but failure_code is "${envelope.failure_code}"`,
        contradictionReason: 'EXIT_ZERO with failure_code',
      };
    }
    if (envelope.termination_classification !== 'TERMINATION_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but termination_classification is not TERMINATION_PROVEN',
        contradictionReason: 'EXIT_ZERO with unproven termination',
      };
    }
    if (envelope.process_start_classification !== 'SPAWNED_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but process_start_classification is not SPAWNED_PROVEN',
        contradictionReason: 'EXIT_ZERO with unproven start',
      };
    }
  } else {
    if (envelope.failure_code === null) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Contradiction: exit_classification is ${envelope.exit_classification} but failure_code is null`,
        contradictionReason: 'Non-zero exit with null failure_code',
      };
    }
  }


  let parsedManifest: ArtifactManifest | null = null;
  const effectiveRawManifestJson = rawManifestJson ?? (manifest ? canonicalizeArtifactManifest(manifest) : undefined);
  const effectiveExpectedManifestHash = expectedManifestHash ?? (effectiveRawManifestJson ? computeArtifactManifestHash(effectiveRawManifestJson) : undefined);

  if (effectiveRawManifestJson && effectiveExpectedManifestHash) {
    try {
      parsedManifest = parseAndVerifyArtifactManifest(effectiveRawManifestJson, effectiveExpectedManifestHash);
    } catch (mParseErr: unknown) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Artifact manifest parsing failed: ${mParseErr instanceof Error ? mParseErr.message : String(mParseErr)}`,
        contradictionReason: 'Artifact manifest parsing failed',
      };
    }

    const computedManifestHash = computeArtifactManifestHash(parsedManifest);
    if (effectiveExpectedManifestHash !== computedManifestHash || envelope.artifact_manifest_hash !== computedManifestHash) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope artifact_manifest_hash mismatch computed manifest hash',
        contradictionReason: 'Artifact manifest hash mismatch',
      };
    }

    if (parsedManifest.adjudication_id !== adjudication.id) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Manifest adjudication_id mismatch',
        contradictionReason: 'Manifest adjudication_id mismatch',
      };
    }
  } else if (manifest) {
    parsedManifest = manifest;
  }

  if (
    envelope.adjudication_id !== adjudication.id ||
    envelope.project_id !== adjudication.project_id ||
    envelope.task_id !== adjudication.task_id ||
    envelope.attempt_id !== adjudication.attempt_id ||
    envelope.assignment_id !== adjudication.assignment_id ||
    envelope.authorization_id !== adjudication.authorization_id ||
    envelope.task_ownership_epoch !== adjudication.task_ownership_epoch ||
    (adjudication.verification_execution_id && envelope.verification_execution_id !== adjudication.verification_execution_id)
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope bindings mismatch adjudication record',
      contradictionReason: 'Envelope adjudication binding mismatch',
    };
  }

  if (
    !envelope.command_snapshot_hash ||
    envelope.command_snapshot_hash !== adjudication.verification_commands_hash
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope command_snapshot_hash mismatch adjudication verification_commands_hash',
      contradictionReason: 'Command snapshot hash mismatch',
    };
  }

  if (
    adjudication.workspace_snapshot_before_hash &&
    envelope.workspace_snapshot_before_hash !== adjudication.workspace_snapshot_before_hash
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope workspace_snapshot_before_hash mismatch adjudication durable snapshot before hash',
      contradictionReason: 'workspace_snapshot_before_hash mismatch',
    };
  }

  if (!envelope.workspace_snapshot_after_hash || !/^[0-9a-f]{64}$/.test(envelope.workspace_snapshot_after_hash)) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope workspace_snapshot_after_hash must be a 64-char lowercase hex string',
      contradictionReason: 'workspace_snapshot_after_hash invalid',
    };
  }



  const manifestMap = new Map<string, ArtifactManifestEntry>();
  if (parsedManifest) {
    const expectedEvidenceIds = new Set<string>();
    if (envelope.test_result_evidence_id) expectedEvidenceIds.add(envelope.test_result_evidence_id);
    if (envelope.git_status_evidence_id) expectedEvidenceIds.add(envelope.git_status_evidence_id);
    if (envelope.git_diff_evidence_id) expectedEvidenceIds.add(envelope.git_diff_evidence_id);

    for (const entry of parsedManifest.entries) {
      if (manifestMap.has(entry.evidence_id)) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Duplicate evidence_id "${entry.evidence_id}" in manifest entries`,
          contradictionReason: 'Duplicate manifest evidence_id',
        };
      }
      manifestMap.set(entry.evidence_id, entry);
    }

    if (
      manifestMap.size !== expectedEvidenceIds.size ||
      [...expectedEvidenceIds].some((id) => !manifestMap.has(id))
    ) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Manifest entries and envelope evidence bindings do not have 1:1 set equality',
        contradictionReason: 'Manifest entry set equality mismatch',
      };
    }
  }

  if (repo && artifactStore && parsedManifest) {
    for (const entry of parsedManifest.entries) {
      const ev = repo.getEvidence(entry.evidence_id);
      if (!ev) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} missing in database`,
          contradictionReason: 'Manifest entry evidence mismatch',
        };
      }
      if (ev.project_id !== adjudication.project_id) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} project_id mismatch: expected ${adjudication.project_id}, got ${ev.project_id}`,
          contradictionReason: 'Manifest entry evidence project mismatch',
        };
      }
      if (ev.task_id !== adjudication.task_id) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} task_id mismatch: expected ${adjudication.task_id}, got ${ev.task_id}`,
          contradictionReason: 'Manifest entry evidence task mismatch',
        };
      }
      if (adjudication.attempt_id && ev.attempt_id !== adjudication.attempt_id) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} attempt_id mismatch: expected ${adjudication.attempt_id}, got ${ev.attempt_id}`,
          contradictionReason: 'Manifest entry evidence attempt mismatch',
        };
      }
      if (ev.evidence_type !== entry.evidence_type) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} evidence_type mismatch: expected ${entry.evidence_type}, got ${ev.evidence_type}`,
          contradictionReason: 'Manifest entry evidence type mismatch',
        };
      }
      if (ev.storage_type !== entry.storage_class) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} storage_class mismatch: expected ${entry.storage_class}, got ${ev.storage_type}`,
          contradictionReason: 'Manifest entry storage class mismatch',
        };
      }
      if (ev.content_type !== entry.content_type) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} content_type mismatch: expected ${entry.content_type}, got ${ev.content_type}`,
          contradictionReason: 'Manifest entry content type mismatch',
        };
      }
      if (ev.byte_size !== entry.byte_size) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} byte_size mismatch: expected ${entry.byte_size}, got ${ev.byte_size}`,
          contradictionReason: 'Manifest entry byte size mismatch',
        };
      }
      if (ev.hash !== entry.sha256) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} sha256 mismatch: expected ${entry.sha256}, got ${ev.hash}`,
          contradictionReason: 'Manifest entry hash mismatch',
        };
      }
      const integ = verifyEvidenceIntegrity(ev, artifactStore);
      if (!integ.valid) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: `Manifest entry evidence ${entry.evidence_id} disk integrity verification failed: ${integ.reason}`,
          contradictionReason: 'Manifest entry disk integrity failed',
        };
      }
    }

    const trManifest = manifestMap.get(envelope.test_result_evidence_id);
    if (!trManifest || trManifest.sha256 !== envelope.test_result_evidence_hash) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope test_result_evidence_id and hash do not match manifest entry',
        contradictionReason: 'test_result_evidence manifest binding mismatch',
      };
    }
    const trRow = repo.getEvidence(envelope.test_result_evidence_id);
    if (!trRow || trRow.hash !== envelope.test_result_evidence_hash) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope test_result_evidence_id and hash do not match durable evidence row',
        contradictionReason: 'test_result_evidence durable binding mismatch',
      };
    }

    if (envelope.git_status_evidence_id) {
      const gsManifest = manifestMap.get(envelope.git_status_evidence_id);
      if (!gsManifest || gsManifest.sha256 !== envelope.git_status_evidence_hash) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: 'Envelope git_status_evidence_id and hash do not match manifest entry',
          contradictionReason: 'git_status_evidence manifest binding mismatch',
        };
      }
      const gsRow = repo.getEvidence(envelope.git_status_evidence_id);
      if (!gsRow || gsRow.hash !== envelope.git_status_evidence_hash) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: 'Envelope git_status_evidence_id and hash do not match durable evidence row',
          contradictionReason: 'git_status_evidence durable binding mismatch',
        };
      }
    }

    if (envelope.git_diff_evidence_id) {
      const gdManifest = manifestMap.get(envelope.git_diff_evidence_id);
      if (!gdManifest || gdManifest.sha256 !== envelope.git_diff_evidence_hash) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: 'Envelope git_diff_evidence_id and hash do not match manifest entry',
          contradictionReason: 'git_diff_evidence manifest binding mismatch',
        };
      }
      const gdRow = repo.getEvidence(envelope.git_diff_evidence_id);
      if (!gdRow || gdRow.hash !== envelope.git_diff_evidence_hash) {
        return {
          valid: false,
          isSuccess: false,
          targetStatus: 'RECOVERY_FENCED',
          taskTransition: 'NEEDS_HUMAN',
          eventType: 'RECOVERY_FENCED',
          dispositionEvent: 'REJECTED',
          dispositionReason: 'RECOVERY_FENCED',
          failureCode: 'INTEGRITY_MISMATCH',
          failureDetail: 'Envelope git_diff_evidence_id and hash do not match durable evidence row',
          contradictionReason: 'git_diff_evidence durable binding mismatch',
        };
      }
    }
  }

  if (
    gitStatusEvidenceId !== undefined &&
    (envelope.git_status_evidence_id || null) !== (gitStatusEvidenceId || null)
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope git_status_evidence_id mismatch',
      contradictionReason: 'git_status_evidence_id mismatch',
    };
  }
  if (
    gitDiffEvidenceId !== undefined &&
    (envelope.git_diff_evidence_id || null) !== (gitDiffEvidenceId || null)
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope git_diff_evidence_id mismatch',
      contradictionReason: 'git_diff_evidence_id mismatch',
    };
  }
  if (
    testResultEvidenceId !== undefined &&
    (envelope.test_result_evidence_id || null) !== (testResultEvidenceId || null)
  ) {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Envelope test_result_evidence_id mismatch',
      contradictionReason: 'test_result_evidence_id mismatch',
    };
  }

  if (repo) {
    const taskEvidenceList = repo.getEvidenceByTask(adjudication.task_id);
    const matchingAfterEvidence = taskEvidenceList.find(
      (ev) => ev.hash === envelope.workspace_snapshot_after_hash
    );
    if (!matchingAfterEvidence) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope workspace_snapshot_after_hash is not backed by durable captured evidence',
        contradictionReason: 'workspace_snapshot_after_hash not backed by durable evidence',
      };
    }
  }

  if (testRun) {
    if (envelope.test_run_id !== testRun.id) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Envelope test_run_id mismatch test run record',
        contradictionReason: 'test_run_id mismatch',
      };
    }
    if (envelope.exit_classification === 'EXIT_ZERO' && testRun.exit_code !== 0) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Test run exit code ${testRun.exit_code} contradicts envelope EXIT_ZERO`,
        contradictionReason: 'exit_code non-zero with EXIT_ZERO',
      };
    }
    if (envelope.exit_classification !== 'EXIT_ZERO' && testRun.exit_code === 0) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Test run exit code 0 contradicts envelope ${envelope.exit_classification}`,
        contradictionReason: 'exit_code zero with non-zero classification',
      };
    }
  } else if (envelope.exit_classification === 'EXIT_ZERO') {
    return {
      valid: false,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: 'INTEGRITY_MISMATCH',
      failureDetail: 'Missing test run record for EXIT_ZERO envelope',
      contradictionReason: 'Missing test run record',
    };
  }

  if (envelope.exit_classification === 'EXIT_ZERO') {
    if (envelope.failure_code !== null) {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: `Contradiction: exit_classification is EXIT_ZERO but failure_code is "${envelope.failure_code}"`,
        contradictionReason: 'EXIT_ZERO with failure_code',
      };
    }
    if (envelope.termination_classification !== 'TERMINATION_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but termination_classification is not TERMINATION_PROVEN',
        contradictionReason: 'EXIT_ZERO with unproven termination',
      };
    }
    if (envelope.process_start_classification !== 'SPAWNED_PROVEN') {
      return {
        valid: false,
        isSuccess: false,
        targetStatus: 'RECOVERY_FENCED',
        taskTransition: 'NEEDS_HUMAN',
        eventType: 'RECOVERY_FENCED',
        dispositionEvent: 'REJECTED',
        dispositionReason: 'RECOVERY_FENCED',
        failureCode: 'INTEGRITY_MISMATCH',
        failureDetail: 'Contradiction: exit_classification is EXIT_ZERO but process_start_classification is not SPAWNED_PROVEN',
        contradictionReason: 'EXIT_ZERO with unspawned process',
      };
    }
  }

  const isCleanSuccess =
    envelope.exit_classification === 'EXIT_ZERO' &&
    envelope.failure_code === null &&
    envelope.process_start_classification === 'SPAWNED_PROVEN' &&
    envelope.termination_classification === 'TERMINATION_PROVEN' &&
    (!testRun || testRun.exit_code === 0);

  if (isCleanSuccess) {
    return {
      valid: true,
      isSuccess: true,
      targetStatus: 'VERIFIED',
      taskTransition: 'REVIEW_READY',
      eventType: 'VERIFICATION_SUCCEEDED',
      dispositionEvent: 'SETTLED',
      dispositionReason: 'ACCEPTED_VERIFIED',
      failureCode: null,
      failureDetail: null,
    };
  }

  const isFencedCode =
    envelope.failure_code === 'ORPHANED_VERIFICATION_INTERRUPTED' ||
    envelope.failure_code === 'ORPHANED_VERIFICATION_CANCELLED' ||
    envelope.failure_code === 'EVIDENCE_CAPTURE_FAILED' ||
    envelope.failure_code === 'INTEGRITY_MISMATCH' ||
    envelope.failure_code === 'RECOVERY_FENCED' ||
    envelope.failure_code === 'CLEANUP_DEBT_FENCED' ||
    envelope.failure_code === 'PROCESS_TERMINATION_UNRESOLVED' ||
    envelope.termination_classification === 'TERMINATION_AMBIGUOUS' ||
    envelope.process_start_classification === 'LAUNCH_FAILED_PROVEN' ||
    Boolean(envelope.failure_payload?.is_fenced);

  if (isFencedCode) {
    return {
      valid: true,
      isSuccess: false,
      targetStatus: 'RECOVERY_FENCED',
      taskTransition: 'NEEDS_HUMAN',
      eventType: 'RECOVERY_FENCED',
      dispositionEvent: 'REJECTED',
      dispositionReason: 'RECOVERY_FENCED',
      failureCode: envelope.failure_code || 'INTEGRITY_MISMATCH',
      failureDetail: extractFailureDetailFromPayload(envelope.failure_payload, envelope.failure_code || 'Process execution ambiguous'),
    };
  }

  return {
    valid: true,
    isSuccess: false,
    targetStatus: 'VERIFICATION_FAILED',
    taskTransition: 'NEEDS_HUMAN',
    eventType: 'VERIFICATION_FAILED',
    dispositionEvent: 'REJECTED',
    dispositionReason: 'VERIFICATION_FAILED',
    failureCode: envelope.failure_code || (envelope.exit_classification === 'TIMEOUT' ? 'VERIFICATION_TIMEOUT' : 'TESTS_FAILED'),
    failureDetail: extractFailureDetailFromPayload(envelope.failure_payload, `Verification failed: ${envelope.exit_classification}`),
  };
}

export class CoderSubmissionAdjudicationService {
  private readonly artifactStore: ArtifactStore;

  constructor(
    private readonly repo: Repository,
    private readonly db: Database.Database,
    private readonly verificationService?: VerificationService,
    private readonly eventService?: EventService
  ) {
    this.artifactStore = this.verificationService?.getArtifactStore() ?? defaultArtifactStore;
  }

  public getArtifactStore(): ArtifactStore {
    return this.artifactStore;
  }

  /**
   * Lists quarantined submissions with integrity status and latest disposition/adjudication.
   */
  public listQuarantinedSubmissions(options: {
    projectId?: string;
    taskId?: string;
    limit?: number;
    offset?: number;
    reverse?: boolean;
  }): { items: QuarantinedSubmissionSummary[]; total: number } {
    if (options.limit !== undefined && (options.limit <= 0 || options.limit > 100)) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Pagination limit must be between 1 and 100');
    }
    if (options.offset !== undefined && options.offset < 0) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Pagination offset must be non-negative');
    }

    const rawSubmissions = this.repo.listRawQuarantinedSubmissions(options);
    const total = this.repo.getQuarantinedSubmissionsCount(options);

    const items: QuarantinedSubmissionSummary[] = rawSubmissions.map((sub) => {
      const integrity = this.validateSubmissionIntegrity(sub);
      const disps = this.repo.getCoderSubmissionDispositions(sub.id);
      const latestDisp = disps.length > 0 ? disps[disps.length - 1] : null;
      const activeAdj = this.repo.getActiveCoderSubmissionAdjudication(sub.id);

      return {
        id: sub.id,
        authorization_id: sub.authorization_id,
        project_id: sub.project_id,
        task_id: sub.task_id,
        task_ownership_epoch: sub.task_ownership_epoch,
        task_revision: sub.task_revision,
        claimed_status: sub.claimed_status,
        quarantine_status: 'QUARANTINED',
        summary: sub.summary,
        changed_files_count: sub.changed_files_count,
        tests_claimed_count: sub.tests_claimed_count,
        blockers_count: sub.blockers_count,
        review_requested: Boolean(sub.review_requested),
        claim_content_hash: sub.claim_content_hash,
        canonical_envelope_hash: sub.canonical_envelope_hash,
        submitted_at: sub.submitted_at,
        integrity_status: integrity.valid ? 'VALID' : 'FENCED_INTEGRITY_CONFLICT',
        integrity_fenced_reasons: integrity.fenced_reasons,
        latest_disposition_event: latestDisp?.disposition_event ?? null,
        latest_disposition_reason: latestDisp?.disposition_reason ?? null,
        active_adjudication: activeAdj
          ? {
              id: activeAdj.id,
              action: activeAdj.action,
              status: activeAdj.status,
              lifecycle_version: activeAdj.lifecycle_version,
              created_at: activeAdj.created_at,
              verification_execution_id: activeAdj.verification_execution_id,
            }
          : null,
      };
    });

    return { items, total };
  }

  /**
   * Detailed inspection of a quarantined submission and its audit trail.
   */
  /**
   * Detailed inspection of a quarantined submission and its audit trail.
   */
  public inspectQuarantinedSubmission(submissionId: string): QuarantinedSubmissionInspection {
    const sub = this.repo.getCoderSubmissionById(submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `Quarantined submission "${submissionId}" not found`
      );
    }

    let claimContent: Record<string, unknown> = {};
    let canonicalEnvelope: Record<string, unknown> = {};
    try {
      const parsedClaim = JSON.parse(sub.claim_content_json);
      if (typeof parsedClaim === 'object' && parsedClaim !== null && !Array.isArray(parsedClaim)) {
        claimContent = parsedClaim as Record<string, unknown>;
      }
      const parsedEnv = JSON.parse(sub.canonical_envelope_json);
      if (typeof parsedEnv === 'object' && parsedEnv !== null && !Array.isArray(parsedEnv)) {
        canonicalEnvelope = parsedEnv as Record<string, unknown>;
      }
    } catch (claimParseErr: unknown) {
      // Malformed stored JSON
    }

    const integrity = this.validateSubmissionIntegrity(sub);
    const dispositions = this.repo.getCoderSubmissionDispositions(sub.id).map((d) => {
      let metadata: Record<string, unknown> | null = null;
      if (d.disposition_metadata_json) {
        try {
          const parsed = JSON.parse(d.disposition_metadata_json);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch (metaErr: unknown) {
          // malformed metadata handled
        }
      }
      return {
        id: d.id,
        disposition_event: d.disposition_event,
        disposition_reason: d.disposition_reason,
        actor_type: d.actor_type,
        actor_id: d.actor_id,
        created_at: d.created_at,
        disposition_metadata: metadata,
      };
    });

    const adjudications = this.repo.getCoderSubmissionAdjudicationsBySubmission(sub.id).map((a) => ({
      id: a.id,
      request_id: a.request_id,
      action: a.action,
      status: a.status,
      lifecycle_version: a.lifecycle_version,
      created_at: a.created_at,
      verification_started_at: a.verification_started_at,
      completed_at: a.completed_at,
      recovery_fenced_at: a.recovery_fenced_at,
      failure_code: a.failure_code,
      test_run_id: a.test_run_id,
      git_status_evidence_id: a.git_status_evidence_id,
      git_diff_evidence_id: a.git_diff_evidence_id,
    }));

    let authoritySnapshot: CanonicalAuthoritySnapshot | null = null;
    try {
      authoritySnapshot = this.buildCanonicalAuthoritySnapshot(sub);
    } catch (authSnapErr: unknown) {
      // Incomplete or malformed authority graph
    }

    const changedFiles = Array.isArray(claimContent.changed_files)
      ? (claimContent.changed_files.filter((f) => typeof f === 'string') as string[])
      : [];
    const testsClaimed = Array.isArray(claimContent.tests_claimed)
      ? (claimContent.tests_claimed.filter((t) => typeof t === 'string') as string[])
      : [];
    const blockers = Array.isArray(claimContent.blockers)
      ? (claimContent.blockers.filter((b) => typeof b === 'string') as string[])
      : [];
    const clientMetadata =
      typeof claimContent.client_metadata === 'object' &&
      claimContent.client_metadata !== null &&
      !Array.isArray(claimContent.client_metadata)
        ? (claimContent.client_metadata as Record<string, unknown>)
        : {};

    return {
      submission: sub,
      candidate: sub,
      authority_snapshot: authoritySnapshot,
      claim_content: {
        summary: sub.summary,
        status: sub.claimed_status,
        changed_files: changedFiles,
        tests_claimed: testsClaimed,
        blockers: blockers,
        review_requested: Boolean(sub.review_requested),
        client_metadata: clientMetadata,
      },
      canonical_envelope: canonicalEnvelope,
      integrity: {
        valid: integrity.valid,
        claim_content_hash_matches: integrity.claim_content_hash_matches,
        canonical_envelope_hash_matches: integrity.canonical_envelope_hash_matches,
        fenced_reasons: integrity.fenced_reasons,
      },
      integrity_status: integrity.valid ? 'VALID' : 'FENCED_INTEGRITY_CONFLICT',
      integrity_fenced_reasons: integrity.fenced_reasons,
      untrusted_claim: {
        summary: sub.summary,
        files_claimed_changed: changedFiles,
        tests_claimed: testsClaimed,
        blockers: blockers,
      },
      dispositions,
      adjudications,
    };
  }

  /**
   * Explicit Owner rejection of a quarantined submission.
   * Creates a terminal REJECTED adjudication and Migration 22 REJECTED disposition.
   * Never mutates task state or executes commands.
   */
  public rejectSubmission(params: {
    requestId: string;
    submissionId: string;
    reason: string;
  }): { adjudication: CoderSubmissionAdjudication; disposition: CoderSubmissionDisposition } {
    // 1. Idempotency by request_id
    const existingAdj = this.repo.getCoderSubmissionAdjudicationByRequestId(params.requestId);
    if (existingAdj) {
      if (existingAdj.submission_id !== params.submissionId || existingAdj.action !== 'REJECT') {
        throw new CoderSubmissionAdjudicationError(
          'REQUEST_ID_CONFLICT',
          `Request ID "${params.requestId}" already exists with different parameters`
        );
      }
      const disps = this.repo.getCoderSubmissionDispositions(params.submissionId);
      const lastDisp = disps.find((d) => d.disposition_event === 'REJECTED') || disps[disps.length - 1];
      return { adjudication: existingAdj, disposition: lastDisp };
    }

    const sub = this.repo.getCoderSubmissionById(params.submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission "${params.submissionId}" not found`);
    }

    // Check active adjudication
    const activeAdj = this.repo.getActiveCoderSubmissionAdjudication(sub.id);
    if (activeAdj) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" already has an active adjudication in state "${activeAdj.status}"`
      );
    }

    // Check terminal disposition
    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');
    if (terminalDisp) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" is already terminal (${terminalDisp.disposition_event} / ${terminalDisp.disposition_reason})`
      );
    }

    // Build canonical authority snapshot
    const snapshot = this.buildCanonicalAuthoritySnapshot(sub);
    const snapshotJson = canonicalJsonStringify(snapshot);
    const snapshotHash = computeSha256(snapshotJson);

    // Determine allowed Migration 22 disposition reason
    const integrity = this.validateSubmissionIntegrity(sub);
    let dispositionReason: 'INTEGRITY_MISMATCH' | 'FENCED_PRECONDITION' | 'COLLISION_CONFLICT';
    if (!integrity.valid) {
      dispositionReason = 'INTEGRITY_MISMATCH';
    } else {
      dispositionReason = 'FENCED_PRECONDITION';
    }

    const nowIso = new Date().toISOString();
    const adjudicationId = deriveDeterministicAdjudicationId(sub.id, params.requestId);
    const dispositionId = deriveDeterministicDispositionId(sub.id, adjudicationId, 1);

    const adjudication: CoderSubmissionAdjudication = {
      id: adjudicationId,
      request_id: params.requestId,
      submission_id: sub.id,
      authorization_id: sub.authorization_id,
      project_id: sub.project_id,
      task_id: sub.task_id,
      attempt_id: snapshot.attempt_id,
      assignment_id: snapshot.assignment_id,
      task_ownership_epoch: sub.task_ownership_epoch,
      action: 'REJECT',
      status: 'REJECTED',
      lifecycle_version: 1,
      authority_snapshot_json: snapshotJson,
      authority_snapshot_hash: snapshotHash,
      verification_commands_json: null,
      verification_commands_hash: null,
      workspace_snapshot_before_json: null,
      workspace_snapshot_before_hash: null,
      verification_execution_id: null,
      protocol_message_id: null,
      test_run_id: null,
      git_status_evidence_id: null,
      git_diff_evidence_id: null,
      failure_code: dispositionReason,
      failure_json: canonicalJsonStringify({ operator_reason: params.reason }),
      created_at: nowIso,
      verification_started_at: null,
      completed_at: nowIso,
      recovery_fenced_at: null,
      verification_result_envelope_json: null,
      verification_result_envelope_hash: null,
    };

    const disposition: CoderSubmissionDisposition = {
      id: dispositionId,
      submission_id: sub.id,
      disposition_event: 'REJECTED',
      disposition_reason: dispositionReason,
      actor_type: 'OPERATOR',
      actor_id: 'OWNER_LOCAL_UI',
      disposition_metadata_json: canonicalJsonStringify({
        adjudication_id: adjudicationId,
        operator_notes: params.reason,
      }),
      created_at: nowIso,
    };

    const eventPayloadJson = canonicalJsonStringify({
      action: 'REJECT',
      adjudication_id: adjudicationId,
      disposition_reason: dispositionReason,
      reason: params.reason,
      submission_id: sub.id,
    });
    const eventPayloadHash = computeSha256(eventPayloadJson);

    const eventId = deriveDeterministicAdjudicationEventId(
      adjudicationId,
      1,
      'REJECTED',
      eventPayloadHash
    );
    const genericEventId = deriveDeterministicGenericAdjudicationEventId(
      adjudicationId,
      1,
      'REJECTED',
      eventPayloadHash
    );

    const adjEvent: CoderSubmissionAdjudicationEvent = {
      id: eventId,
      adjudication_id: adjudicationId,
      sequence: 1,
      event_type: 'REJECTED',
      payload_json: eventPayloadJson,
      payload_hash: eventPayloadHash,
      created_at: nowIso,
    };

    // Execute atomic transaction
    this.repo.runInTransaction(() => {
      this.repo.createCoderSubmissionAdjudication(adjudication);
      this.repo.createCoderSubmissionDisposition(disposition);
      this.repo.createCoderSubmissionAdjudicationEvent(adjEvent);
      this.repo.createDeterministicGenericEvent({
        id: genericEventId,
        project_id: sub.project_id,
        task_id: sub.task_id,
        agent_id: null,
        type: 'CODER_SUBMISSION_REJECTED',
        summary: `Quarantined coder submission ${sub.id} rejected by operator: ${params.reason}`,
        structured_payload: { adjudicationId, dispositionReason, submissionId: sub.id },
        timestamp: nowIso,
      });
    });

    return { adjudication, disposition };
  }

  /**
   * Explicit Owner supersession of an older submission by a replacement submission.
   * Appends SETTLED / SUPERSEDED_SUBMISSION.
   * Never mutates task state or runs commands.
   */
  public supersedeSubmission(params: {
    requestId: string;
    submissionId: string;
    replacementSubmissionId: string;
    reason: string;
  }): { adjudication: CoderSubmissionAdjudication; disposition: CoderSubmissionDisposition } {
    // 1. Idempotency check
    const existingAdj = this.repo.getCoderSubmissionAdjudicationByRequestId(params.requestId);
    if (existingAdj) {
      if (existingAdj.submission_id !== params.submissionId || existingAdj.action !== 'SUPERSEDE') {
        throw new CoderSubmissionAdjudicationError(
          'REQUEST_ID_CONFLICT',
          `Request ID "${params.requestId}" already exists with different parameters`
        );
      }
      const disps = this.repo.getCoderSubmissionDispositions(params.submissionId);
      const lastDisp = disps.find((d) => d.disposition_reason === 'SUPERSEDED_SUBMISSION') || disps[disps.length - 1];
      return { adjudication: existingAdj, disposition: lastDisp };
    }

    if (params.submissionId === params.replacementSubmissionId) {
      throw new CoderSubmissionAdjudicationError(
        'PRECONDITION_FENCED',
        'Submission cannot supersede itself'
      );
    }

    const sub = this.repo.getCoderSubmissionById(params.submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission "${params.submissionId}" not found`);
    }

    const replacementSub = this.repo.getCoderSubmissionById(params.replacementSubmissionId);
    if (!replacementSub) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `Replacement submission "${params.replacementSubmissionId}" not found`
      );
    }

    // Must bind to exact same authority tuple
    if (
      sub.project_id !== replacementSub.project_id ||
      sub.task_id !== replacementSub.task_id ||
      sub.authorization_id !== replacementSub.authorization_id
    ) {
      throw new CoderSubmissionAdjudicationError(
        'PRECONDITION_FENCED',
        'Replacement submission does not bind to the same authority tuple (project, task, authorization)'
      );
    }

    // Check terminal disposition on target
    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');
    if (terminalDisp) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" is already terminal (${terminalDisp.disposition_event} / ${terminalDisp.disposition_reason})`
      );
    }

    const snapshot = this.buildCanonicalAuthoritySnapshot(sub);
    const snapshotJson = canonicalJsonStringify(snapshot);
    const snapshotHash = computeSha256(snapshotJson);

    const nowIso = new Date().toISOString();
    const adjudicationId = deriveDeterministicAdjudicationId(sub.id, params.requestId);
    const dispositionId = deriveDeterministicDispositionId(sub.id, adjudicationId, 1);

    const adjudication: CoderSubmissionAdjudication = {
      id: adjudicationId,
      request_id: params.requestId,
      submission_id: sub.id,
      authorization_id: sub.authorization_id,
      project_id: sub.project_id,
      task_id: sub.task_id,
      attempt_id: snapshot.attempt_id,
      assignment_id: snapshot.assignment_id,
      task_ownership_epoch: sub.task_ownership_epoch,
      action: 'SUPERSEDE',
      status: 'SUPERSEDED',
      lifecycle_version: 1,
      authority_snapshot_json: snapshotJson,
      authority_snapshot_hash: snapshotHash,
      verification_commands_json: null,
      verification_commands_hash: null,
      workspace_snapshot_before_json: null,
      workspace_snapshot_before_hash: null,
      verification_execution_id: null,
      protocol_message_id: null,
      test_run_id: null,
      git_status_evidence_id: null,
      git_diff_evidence_id: null,
      failure_code: null,
      failure_json: canonicalJsonStringify({
        operator_reason: params.reason,
        replacement_submission_id: params.replacementSubmissionId,
      }),
      created_at: nowIso,
      verification_started_at: null,
      completed_at: nowIso,
      recovery_fenced_at: null,
      verification_result_envelope_json: null,
      verification_result_envelope_hash: null,
    };

    const disposition: CoderSubmissionDisposition = {
      id: dispositionId,
      submission_id: sub.id,
      disposition_event: 'SETTLED',
      disposition_reason: 'SUPERSEDED_SUBMISSION',
      actor_type: 'OPERATOR',
      actor_id: 'OWNER_LOCAL_UI',
      disposition_metadata_json: canonicalJsonStringify({
        adjudication_id: adjudicationId,
        operator_notes: params.reason,
        replacement_submission_id: params.replacementSubmissionId,
      }),
      created_at: nowIso,
    };

    const eventPayloadJson = canonicalJsonStringify({
      action: 'SUPERSEDE',
      adjudication_id: adjudicationId,
      reason: params.reason,
      replacement_submission_id: params.replacementSubmissionId,
      submission_id: sub.id,
    });
    const eventPayloadHash = computeSha256(eventPayloadJson);

    const eventId = deriveDeterministicAdjudicationEventId(
      adjudicationId,
      1,
      'SUPERSEDED',
      eventPayloadHash
    );
    const genericEventId = deriveDeterministicGenericAdjudicationEventId(
      adjudicationId,
      1,
      'SUPERSEDED',
      eventPayloadHash
    );

    const adjEvent: CoderSubmissionAdjudicationEvent = {
      id: eventId,
      adjudication_id: adjudicationId,
      sequence: 1,
      event_type: 'SUPERSEDED',
      payload_json: eventPayloadJson,
      payload_hash: eventPayloadHash,
      created_at: nowIso,
    };

    this.repo.runInTransaction(() => {
      this.repo.createCoderSubmissionAdjudication(adjudication);
      this.repo.createCoderSubmissionDisposition(disposition);
      this.repo.createCoderSubmissionAdjudicationEvent(adjEvent);
      this.repo.createDeterministicGenericEvent({
        id: genericEventId,
        project_id: sub.project_id,
        task_id: sub.task_id,
        agent_id: null,
        type: 'CODER_SUBMISSION_SUPERSEDED',
        summary: `Submission ${sub.id} superseded by ${params.replacementSubmissionId}: ${params.reason}`,
        structured_payload: { adjudicationId, replacementSubmissionId: params.replacementSubmissionId, submissionId: sub.id },
        timestamp: nowIso,
      });
    });

    return { adjudication, disposition };
  }

  /**
   * Three-Phase Verification Protocol for Quarantined Submission Admission.
   */
  public async admitSubmissionForVerification(params: {
    requestId: string;
    submissionId: string;
    resumeAdjudicationId?: string;
  }): Promise<{ adjudication: CoderSubmissionAdjudication; status: AdjudicationStatus }> {
    // 1. Check idempotency by request_id
    const existingAdj = this.repo.getCoderSubmissionAdjudicationByRequestId(params.requestId);
    if (existingAdj) {
      if (existingAdj.submission_id !== params.submissionId || existingAdj.action !== 'ADMIT_VERIFICATION') {
        throw new CoderSubmissionAdjudicationError(
          'REQUEST_ID_CONFLICT',
          `Request ID "${params.requestId}" already exists with different parameters`
        );
      }
      return { adjudication: existingAdj, status: existingAdj.status };
    }

    // 2. Load submission and validate integrity
    const sub = this.repo.getCoderSubmissionById(params.submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission "${params.submissionId}" not found`);
    }

    const integrity = this.validateSubmissionIntegrity(sub);
    if (!integrity.valid) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Submission integrity validation failed: ${integrity.fenced_reasons.join('; ')}`
      );
    }

    // Check active adjudication on submission
    const existingActive = this.repo.getActiveCoderSubmissionAdjudication(sub.id);
    if (existingActive) {
      if (!params.resumeAdjudicationId || existingActive.id !== params.resumeAdjudicationId) {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Submission "${sub.id}" already has an active adjudication (${existingActive.status})`
        );
      }
    }

    // Check terminal disposition
    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');
    if (terminalDisp) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" is already settled or rejected (${terminalDisp.disposition_event} / ${terminalDisp.disposition_reason})`
      );
    }

    // 3. Authority Snapshot & Frozen Command Validation
    const project = this.repo.getProject(sub.project_id);
    if (!project) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Project not found');
    }
    if (project.status !== 'RUNNING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Project must be in RUNNING status (got ${project.status})`);
    }

    const task = this.repo.getTask(sub.task_id);
    if (!task) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Task not found');
    }
    if (!params.resumeAdjudicationId && task.state !== 'CODING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Task must be in CODING state (got ${task.state})`);
    }
    if (params.resumeAdjudicationId && task.state !== 'VALIDATING' && task.state !== 'CODING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Task must be in VALIDATING or CODING state to resume (got ${task.state})`);
    }
    if (task.ownership_epoch !== sub.task_ownership_epoch) {
      throw new CoderSubmissionAdjudicationError(
        'PRECONDITION_FENCED',
        `Task ownership epoch mismatch: task (${task.ownership_epoch}) does not match submission (${sub.task_ownership_epoch})`
      );
    }

    const auth = this.repo.getExecutionAuthorization(sub.authorization_id);
    if (!auth || !auth.canonical_payload_json) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Execution authorization missing or lacks canonical_payload_json'
      );
    }
    const payloadValidation = validateAndHashCanonicalExecutionPayload(auth.canonical_payload_json);
    if (!payloadValidation.valid) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        `Execution authorization canonical payload invalid: ${payloadValidation.error}`
      );
    }
    if (auth.instruction_payload_hash && payloadValidation.computedHash !== auth.instruction_payload_hash) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        'Execution authorization canonical payload hash mismatch (INSTRUCTION_PAYLOAD_HASH_MISMATCH)'
      );
    }
    if (auth.status !== 'DISPATCHED') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Execution authorization must be in DISPATCHED status (got ${auth.status})`);
    }
    if (auth.repository_head_sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase()) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `HEAD drift: authorized repository head SHA (${auth.repository_head_sha}) does not match submission (${sub.authorized_head_sha})`
      );
    }

    if (!auth.attempt_id) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing attempt_id');
    }
    const attempt = this.repo.getTaskAttempt(auth.attempt_id);
    if (!attempt) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Attempt not found');
    }
    if (attempt.status !== 'RUNNING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Task attempt must be in RUNNING status (got ${attempt.status})`);
    }

    if (!auth.assignment_id) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing assignment_id');
    }
    const assignment = this.repo.getAgentAssignment(auth.assignment_id);
    if (!assignment) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Assignment not found');
    }
    if (assignment.status !== 'ASSIGNED') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Agent assignment must be in ASSIGNED status (got ${assignment.status})`);
    }

    // Provider / account / resource binding check between auth and assignment
    if (
      (auth.selected_provider_id && assignment.selected_provider_id && auth.selected_provider_id !== assignment.selected_provider_id) ||
      (auth.selected_account_id && assignment.selected_account_id && auth.selected_account_id !== assignment.selected_account_id) ||
      (auth.selected_resource_id && assignment.selected_resource_id && auth.selected_resource_id !== assignment.selected_resource_id)
    ) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Provider mismatch: provider, account, or resource mismatch between authorization and assignment');
    }

    const snapshot = this.buildCanonicalAuthoritySnapshot(sub);
    const snapshotJson = canonicalJsonStringify(snapshot);
    const snapshotHash = computeSha256(snapshotJson);

    let authPayload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(auth.canonical_payload_json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Not an object');
      }
      authPayload = parsed as Record<string, unknown>;
    } catch (parseErr: unknown) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Authorization canonical payload is malformed JSON'
      );
    }

    const frozenCommands = authPayload.verificationCommands as Record<string, unknown> | undefined;
    if (!frozenCommands || typeof frozenCommands !== 'object') {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Frozen verificationCommands snapshot missing from authorization'
      );
    }

    const frozenTestCmd = frozenCommands.TEST as Record<string, unknown> | undefined;
    if (!frozenTestCmd || typeof frozenTestCmd.executable !== 'string' || !Array.isArray(frozenTestCmd.args)) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'No valid frozen TEST command snapshot configured in authorization'
      );
    }

    const rawTimeout = frozenTestCmd.timeout_ms;
    if (typeof rawTimeout !== 'number' || !Number.isInteger(rawTimeout) || rawTimeout <= 0 || rawTimeout > 600000) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        `Verification test command timeout_ms must be a positive integer <= 600000 (got ${rawTimeout})`
      );
    }

    const verificationCommandsJson = canonicalJsonStringify(frozenCommands);
    const verificationCommandsHash = computeSha256(verificationCommandsJson);

    // 4. Pre-transaction external Git reads
    if (!project.repository_path) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Project repository path missing');
    }

    const prePhaseAFingerprint = await this.captureCanonicalWorkspaceFingerprint(project.repository_path, sub.base_sha);
    if (prePhaseAFingerprint.head_sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase()) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Live repository HEAD drift: live HEAD (${prePhaseAFingerprint.head_sha}) has drifted from authorized HEAD (${sub.authorized_head_sha})`
      );
    }
    if (prePhaseAFingerprint.status_lines.length > 0) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Working directory has uncommitted changes in ${project.repository_path}`
      );
    }

    // =========================================================================
    // PHASE A: ADMISSION TRANSACTION (Short BEGIN IMMEDIATE)
    // =========================================================================
    let adjudicationId: string;
    const phaseANowIso = new Date().toISOString();

    if (params.resumeAdjudicationId) {
      adjudicationId = params.resumeAdjudicationId;
    } else {
      adjudicationId = deriveDeterministicAdjudicationId(sub.id, params.requestId);
      const syntheticMsgId = `msg-sub-${sub.id}`;
      const syntheticProtocolId = deriveDeterministicAdjudicationId('protocol', sub.id);

      const admissionAdjudication: CoderSubmissionAdjudication = {
        id: adjudicationId,
        request_id: params.requestId,
        submission_id: sub.id,
        authorization_id: sub.authorization_id,
        project_id: sub.project_id,
        task_id: sub.task_id,
        attempt_id: snapshot.attempt_id,
        assignment_id: snapshot.assignment_id,
        task_ownership_epoch: sub.task_ownership_epoch,
        action: 'ADMIT_VERIFICATION',
        status: 'ADMITTED',
        lifecycle_version: 1,
        authority_snapshot_json: snapshotJson,
        authority_snapshot_hash: snapshotHash,
        verification_commands_json: verificationCommandsJson,
        verification_commands_hash: verificationCommandsHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        workspace_lease_id: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        verification_execution_id: null,
        protocol_message_id: syntheticProtocolId,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        failure_code: null,
        failure_json: null,
        created_at: phaseANowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
      };

      const admitEventPayload = canonicalJsonStringify({
        action: 'ADMIT_VERIFICATION',
        adjudication_id: adjudicationId,
        head_sha: prePhaseAFingerprint.head_sha,
        submission_id: sub.id,
      });
      const admitEventHash = computeSha256(admitEventPayload);
      const admitEventId = deriveDeterministicAdjudicationEventId(
        adjudicationId,
        1,
        'ADMITTED',
        admitEventHash
      );
      const genericEventId = deriveDeterministicGenericAdjudicationEventId(
        adjudicationId,
        1,
        'ADMITTED',
        admitEventHash
      );

      const admitEvent: CoderSubmissionAdjudicationEvent = {
        id: admitEventId,
        adjudication_id: adjudicationId,
        sequence: 1,
        event_type: 'ADMITTED',
        payload_json: admitEventPayload,
        payload_hash: admitEventHash,
        created_at: phaseANowIso,
      };

      this.repo.runInTransaction(() => {
        // Re-verify live task state in transaction
        const liveTask = this.repo.getTask(sub.task_id);
        if (!liveTask || (liveTask.state !== 'CODING' && liveTask.state !== 'VALIDATING')) {
          throw new CoderSubmissionAdjudicationError(
            'PRECONDITION_FENCED',
            `Task "${sub.task_id}" state is "${liveTask?.state}", must be "CODING" or "VALIDATING"`
          );
        }
        if (liveTask.ownership_epoch !== sub.task_ownership_epoch) {
          throw new CoderSubmissionAdjudicationError(
            'INTEGRITY_CONFLICT',
            `Task ownership epoch mismatch: task (${liveTask.ownership_epoch}) does not match submission (${sub.task_ownership_epoch})`
          );
        }

        // Record synthetic protocol message
        this.repo.recordProtocolMessage(
          syntheticProtocolId,
          syntheticMsgId,
          'coder.v1',
          sub.project_id,
          sub.task_id,
          'CODING',
          sub.task_revision,
          sub.claim_content_hash,
          sub.claim_content_json,
          'APPLIED'
        );

        // Transition task CODING -> VALIDATING if in CODING
        if (liveTask.state === 'CODING') {
          const transitionRes = TaskStateMachine.transition(liveTask.state, 'SUBMIT_REPORT', {
            revisionCount: liveTask.revision_count,
            maxRevisions: liveTask.max_revisions,
            pausedFromState: liveTask.paused_from_state,
          });

          this.repo.updateTaskState(
            liveTask.id,
            transitionRes.nextState,
            transitionRes.pausedFromState,
            transitionRes.incrementRevision
          );
        }

        // Create adjudication record & events
        this.repo.createCoderSubmissionAdjudication(admissionAdjudication);
        this.repo.createCoderSubmissionAdjudicationEvent(admitEvent);
        this.repo.createDeterministicGenericEvent({
          id: genericEventId,
          project_id: sub.project_id,
          task_id: sub.task_id,
          agent_id: null,
          type: 'CODER_SUBMISSION_ADMITTED',
          summary: `Quarantined coder submission ${sub.id} admitted for verification on task ${sub.task_id}`,
          structured_payload: { adjudicationId, headSha: prePhaseAFingerprint.head_sha, submissionId: sub.id },
          timestamp: phaseANowIso,
        });
      });
    }

    // =========================================================================
    // PHASE B1: EXCLUSIVE WORKSPACE LEASE ACQUISITION (Atomic Immediate Tx 1)
    // =========================================================================
    const worktreeIdentityHash = computeSha256(path.resolve(project.repository_path).toLowerCase());
    const leaseId = crypto.randomUUID();
    const claimNonce = crypto.randomUUID();
    const phaseBStartIso = new Date().toISOString();
    const executionId = crypto.randomUUID();

    this.repo.runInTransaction(() => {
      const currentSub = this.repo.getCoderSubmissionById(sub.id);
      if (!currentSub) {
        throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission ${sub.id} not found`);
      }
      const liveAuth = this.validateSubmissionAndAuthorityIntegrity(currentSub);
      if (!liveAuth.valid) {
        throw new CoderSubmissionAdjudicationError(
          'PRECONDITION_FENCED',
          `Phase B1 authority verification failed: ${liveAuth.fenced_reasons.join('; ')}`
        );
      }

      // Check active workspace lease
      const activeLease = this.repo.getActiveWorkspaceLeaseByWorktree(worktreeIdentityHash);
      if (activeLease) {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Active workspace verification lease (${activeLease.id}) already held for worktree`
        );
      }

      const currentAdj = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
      if (!currentAdj || currentAdj.status !== 'ADMITTED' || currentAdj.verification_execution_id !== null) {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Adjudication "${adjudicationId}" not in eligible ADMITTED state for lease acquisition`
        );
      }

      // Insert lease in ACQUIRED state
      this.repo.createWorkspaceLease({
        id: leaseId,
        adjudication_id: adjudicationId,
        worktree_identity_hash: worktreeIdentityHash,
        admitted_workspace_fingerprint_hash: computeSha256(canonicalJsonStringify(prePhaseAFingerprint)),
        pre_execution_fingerprint_hash: null,
        claim_nonce: claimNonce,
        execution_id: executionId,
        lease_owner_identity: snapshot.assignment_id,
        assignment_id: snapshot.assignment_id,
        authorization_id: sub.authorization_id,
        acquired_at: phaseBStartIso,
        released_at: null,
        lifecycle_version: 1,
        state: 'ACQUIRED',
        failure_code: null,
        failure_evidence_hash: null,
      });
    });

    // =========================================================================
    // PHASE B2: CAPTURE FRESH WORKSPACE OBSERVATION WHILE LEASE HELD (Outside DB)
    // =========================================================================
    let freshPhaseBObservation: CanonicalWorkspaceFingerprint;
    try {
      freshPhaseBObservation = await this.captureCanonicalWorkspaceFingerprint(
        project.repository_path,
        sub.base_sha
      );
    } catch (obsErr: unknown) {
      this.repo.runInTransaction(() => {
        const l = this.repo.getWorkspaceLease(leaseId);
        if (l && l.released_at === null) {
          this.repo.updateWorkspaceLease(leaseId, l.lifecycle_version, {
            state: 'FENCED',
            failure_code: 'WORKTREE_DRIFT',
            released_at: new Date().toISOString(),
          });
        }
        const a = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
        if (a && a.status === 'ADMITTED') {
          this.repo.updateCoderSubmissionAdjudication(adjudicationId, a.lifecycle_version, {
            status: 'RECOVERY_FENCED',
            failure_code: 'WORKTREE_DRIFT',
            recovery_fenced_at: new Date().toISOString(),
            workspace_lease_id: leaseId,
          });
        }
      });
      throw new CoderSubmissionAdjudicationError('WORKTREE_DRIFT', `Failed to capture observation: ${obsErr instanceof Error ? obsErr.message : String(obsErr)}`);
    }

    if (freshPhaseBObservation.head_sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase() || freshPhaseBObservation.status_lines.length > 0) {
      const reason = freshPhaseBObservation.head_sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase()
        ? `Live repository HEAD drift before claim: live HEAD (${freshPhaseBObservation.head_sha}) has drifted from authorized HEAD (${sub.authorized_head_sha})`
        : `Working directory has uncommitted changes before execution claim in ${project.repository_path}`;
      this.repo.runInTransaction(() => {
        const l = this.repo.getWorkspaceLease(leaseId);
        if (l && l.released_at === null) {
          this.repo.updateWorkspaceLease(leaseId, l.lifecycle_version, {
            state: 'FENCED',
            failure_code: 'WORKTREE_DRIFT',
            released_at: new Date().toISOString(),
          });
        }
        const a = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
        if (a && a.status === 'ADMITTED') {
          this.repo.updateCoderSubmissionAdjudication(adjudicationId, a.lifecycle_version, {
            status: 'RECOVERY_FENCED',
            failure_code: 'WORKTREE_DRIFT',
            recovery_fenced_at: new Date().toISOString(),
            workspace_lease_id: leaseId,
          });
        }
      });
      throw new CoderSubmissionAdjudicationError('WORKTREE_DRIFT', reason);
    }

    // =========================================================================
    // PHASE B3: FINAL EXECUTION CLAIM TRANSACTION (Atomic CAS Tx 2)
    // =========================================================================
    const phaseBNowIso = new Date().toISOString();

    const workspaceSnapshotJson = canonicalJsonStringify(freshPhaseBObservation);
    const workspaceSnapshotHash = computeSha256(workspaceSnapshotJson);

    const claimEventPayload = canonicalJsonStringify({
      adjudication_id: adjudicationId,
      started_at: phaseBNowIso,
      verification_execution_id: executionId,
    });
    const claimEventHash = computeSha256(claimEventPayload);
    const claimEventId = deriveDeterministicAdjudicationEventId(
      adjudicationId,
      2,
      'VERIFICATION_CLAIMED',
      claimEventHash
    );
    const genericClaimEventId = deriveDeterministicGenericAdjudicationEventId(
      adjudicationId,
      2,
      'VERIFICATION_CLAIMED',
      claimEventHash
    );

    const claimEvent: CoderSubmissionAdjudicationEvent = {
      id: claimEventId,
      adjudication_id: adjudicationId,
      sequence: 2,
      event_type: 'VERIFICATION_CLAIMED',
      payload_json: claimEventPayload,
      payload_hash: claimEventHash,
      created_at: phaseBNowIso,
    };

    let claimed = false;
    this.repo.runInTransaction(() => {
      // Reload and verify live submission and adjudication state in claim transaction
      const currentSub = this.repo.getCoderSubmissionById(sub.id);
      if (!currentSub) {
        throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission ${sub.id} not found`);
      }
      const currentAdj = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
      if (!currentAdj) {
        throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Adjudication ${adjudicationId} not found`);
      }
      if (currentAdj.status !== 'ADMITTED') {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Adjudication "${adjudicationId}" is in status "${currentAdj.status}", expected "ADMITTED"`
        );
      }
      if (currentAdj.verification_execution_id !== null) {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Adjudication "${adjudicationId}" already has execution claim`
        );
      }

      const lease = this.repo.getWorkspaceLease(leaseId);
      if (!lease || lease.state !== 'ACQUIRED' || lease.released_at !== null || lease.claim_nonce !== claimNonce) {
        throw new CoderSubmissionAdjudicationError(
          'STATUS_CONFLICT',
          'Exclusive workspace lease invalid, expired, or state conflict'
        );
      }

      // Run the full shared authority verifier inside transaction
      const liveAuthIntegrity = this.validateSubmissionAndAuthorityIntegrity(currentSub);
      if (!liveAuthIntegrity.valid) {
        throw new CoderSubmissionAdjudicationError(
          'PRECONDITION_FENCED',
          `Phase B authority verification failed: ${liveAuthIntegrity.fenced_reasons.join('; ')}`
        );
      }

      // Validate project/task/attempt/assignment/auth/provider/account/resource/slot/lease state
      const liveProject = this.repo.getProject(sub.project_id);
      if (!liveProject || liveProject.status !== 'RUNNING') {
        throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Project is not RUNNING');
      }
      const liveTask = this.repo.getTask(sub.task_id);
      if (!liveTask || (liveTask.state !== 'CODING' && liveTask.state !== 'VALIDATING')) {
        throw new CoderSubmissionAdjudicationError(
          'STATUS_CONFLICT',
          `Task "${sub.task_id}" state is "${liveTask?.state}", must be "CODING" or "VALIDATING"`
        );
      }
      const liveAttempt = this.repo.getTaskAttempt(snapshot.attempt_id);
      if (!liveAttempt || liveAttempt.status !== 'RUNNING') {
        throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Task attempt is inactive');
      }
      const liveAssignment = this.repo.getAgentAssignment(snapshot.assignment_id);
      if (!liveAssignment || (liveAssignment.status !== 'ASSIGNED' && liveAssignment.status !== 'RUNNING')) {
        throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Agent assignment is inactive');
      }

      // If task is in CODING, transition to VALIDATING atomically inside claim transaction
      if (liveTask.state === 'CODING') {
        const transitionRes = TaskStateMachine.transition(liveTask.state, 'SUBMIT_REPORT', {
          revisionCount: liveTask.revision_count,
          maxRevisions: liveTask.max_revisions,
          pausedFromState: liveTask.paused_from_state,
        });
        this.repo.updateTaskState(
          liveTask.id,
          transitionRes.nextState,
          transitionRes.pausedFromState,
          transitionRes.incrementRevision
        );
      }

      claimed = this.repo.updateCoderSubmissionAdjudication(adjudicationId, currentAdj.lifecycle_version, {
        status: 'VERIFYING',
        verification_execution_id: executionId,
        verification_started_at: phaseBNowIso,
        workspace_snapshot_before_json: workspaceSnapshotJson,
        workspace_snapshot_before_hash: workspaceSnapshotHash,
        workspace_lease_id: leaseId,
      });

      if (!claimed) {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Settlement claim CAS failed on adjudication ${adjudicationId}`
        );
      }

      // CAS lease: ACQUIRED -> VERIFYING with execution_id
      const leaseUpdated = this.repo.updateWorkspaceLease(leaseId, lease.lifecycle_version, {
        state: 'VERIFYING',
        execution_id: executionId,
        pre_execution_fingerprint_hash: workspaceSnapshotHash,
      });
      if (!leaseUpdated) {
        throw new CoderSubmissionAdjudicationError(
          'STATUS_CONFLICT',
          `Workspace lease CAS failed on lease ${leaseId}`
        );
      }

      this.repo.createCoderSubmissionAdjudicationEvent(claimEvent);
      this.repo.createDeterministicGenericEvent({
        id: genericClaimEventId,
        project_id: sub.project_id,
        task_id: sub.task_id,
        agent_id: null,
        type: 'CODER_SUBMISSION_CLAIMED',
        summary: `Verification execution claimed on adjudication ${adjudicationId}`,
        structured_payload: { adjudicationId, executionId, startedAt: phaseBNowIso },
        timestamp: phaseBNowIso,
      });
    });

    if (!claimed) {
      throw new CoderSubmissionAdjudicationError(
        'VERIFICATION_IN_FLIGHT',
        `Failed to claim execution on adjudication "${adjudicationId}" (already claimed or version mismatch)`
      );
    }

    // =========================================================================
    // EXTERNAL VERIFICATION EXECUTION (Outside All Database Transactions)
    // =========================================================================
    const timeoutMs = rawTimeout;

    const sealedInput: SealedVerificationExecutionInput = {
      adjudication_id: adjudicationId,
      lifecycle_version: 2,
      verification_execution_id: executionId,
      authorization_id: sub.authorization_id,
      project_id: sub.project_id,
      task_id: sub.task_id,
      attempt_id: snapshot.attempt_id,
      assignment_id: snapshot.assignment_id,
      repo_path: project.repository_path,
      verification_commands_json: verificationCommandsJson,
      verification_commands_hash: verificationCommandsHash,
      workspace_snapshot_before_json: workspaceSnapshotJson,
      workspace_snapshot_before_hash: workspaceSnapshotHash,
      policy: {
        timeout_ms: timeoutMs,
        max_stdout_bytes: ProcessRunner.DEFAULT_MAX_OUTPUT_BYTES,
        max_stderr_bytes: ProcessRunner.DEFAULT_MAX_OUTPUT_BYTES,
        allowed_env_keys: ['NODE_ENV', 'PATH', 'Path', 'SYSTEMROOT', 'TEMP', 'TMP'],
      },
    };

    const newlyMaterializedPaths: string[] = [];
    let verificationResult: VerificationExecutionObservation;
    try {
      verificationResult = await this.verificationService!.executeSealedVerification(sealedInput);
    } catch (verifErr: unknown) {
      const cleanupRes = this.artifactStore.cleanupRollbackFiles(newlyMaterializedPaths);
      const isCleanupDebt = cleanupRes.failures && cleanupRes.failures.length > 0;
      const failureCode = isCleanupDebt ? 'CLEANUP_DEBT_FENCED' : 'ORPHANED_VERIFICATION_CANCELLED';
      const failureDetail = verifErr instanceof Error ? verifErr.message : String(verifErr);

      try {
        const nowIso = new Date().toISOString();
        this.db.prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'RECOVERY_FENCED',
              failure_code = ?,
              failure_json = ?,
              recovery_fenced_at = ?,
              completed_at = ?,
              lifecycle_version = lifecycle_version + 1
          WHERE id = ? AND status IN ('ADMITTED', 'VERIFYING')
        `).run(failureCode, JSON.stringify({ error: failureDetail }), nowIso, nowIso, adjudicationId);

        if (leaseId) {
          this.db.prepare(`
            UPDATE coder_submission_workspace_leases
            SET state = 'FENCED',
                failure_code = ?,
                released_at = ?,
                lifecycle_version = lifecycle_version + 1
            WHERE id = ? AND state IN ('ACQUIRED', 'VERIFYING')
          `).run(failureCode, nowIso, leaseId);
        }
      } catch (fenceErr: unknown) {
        const fenceMsg = fenceErr instanceof Error ? fenceErr.message : String(fenceErr);
        const origMsg = verifErr instanceof Error ? verifErr.message : String(verifErr);
        throw new Error(`VERIFICATION_ABORT_WITH_FENCE_FAILURE: Verification aborted: [${origMsg}]. Lease fencing failed: [${fenceMsg}].`);
      }
      throw verifErr;
    }

    // Collect post-run Git evidence & post-run observation outside all transactions
    let postGitStatus: GitStatusSummary | null = null;
    let postGitDiff: GitDiffSummary | null = null;
    let postObservation: CanonicalWorkspaceFingerprint | null = null;
    let driftDetected = false;
    let driftReason = '';

    try {
      postObservation = await this.captureCanonicalWorkspaceFingerprint(project.repository_path, sub.base_sha);
      postGitStatus = await GitService.getStatus(project.repository_path);
      postGitDiff = await GitService.getDiff(project.repository_path, sub.base_sha);

      if (postObservation.head_sha.toLowerCase() !== freshPhaseBObservation.head_sha.toLowerCase()) {
        driftDetected = true;
        driftReason = `Repository HEAD moved during verification from ${freshPhaseBObservation.head_sha} to ${postObservation.head_sha}`;
      } else if (postObservation.diff_hash !== freshPhaseBObservation.diff_hash) {
        driftDetected = true;
        driftReason = `Tracked git diff content changed during verification`;
      } else if (postObservation.untracked_files_hash !== freshPhaseBObservation.untracked_files_hash) {
        driftDetected = true;
        driftReason = `Untracked files modified or added during verification`;
      }
    } catch (obsErr: unknown) {
      const msg = obsErr instanceof Error ? obsErr.message : String(obsErr);
      driftDetected = true;
      driftReason = `Failed to capture post-verification workspace observation: ${msg}`;
    }

    // =========================================================================
    // DETERMINISTIC CONTENT-ADDRESSED ARTIFACT MATERIALIZATION (Outside DB)
    // =========================================================================
    const phaseCNowIso = new Date().toISOString();

    // 1. Git Status Evidence
    let stagedGitStatusEvidence: Evidence | null = null;
    let statusEvId = '';
    let statusHash = '';
    let statusByteSize = 0;
    let materializedStatusPath = '';
    if (postGitStatus) {
      statusEvId = crypto.randomUUID();
      const statusContent = JSON.stringify(postGitStatus, null, 2);
      statusHash = computeSha256(statusContent);
      statusByteSize = Buffer.byteLength(statusContent, 'utf8');
      const mat = this.artifactStore.materializeContentAddressedFile(statusContent, statusHash);
      if (mat.newlyCreated) newlyMaterializedPaths.push(mat.filePath);
      materializedStatusPath = mat.filePath;
      stagedGitStatusEvidence = {
        id: statusEvId,
        project_id: sub.project_id,
        task_id: sub.task_id,
        attempt_id: snapshot.attempt_id,
        evidence_type: 'GIT_STATUS',
        summary: `Git Status: ${postGitStatus.isClean ? 'Clean' : 'Modified'} on ${postGitStatus.branch ?? 'main'}`,
        content_type: 'application/json',
        hash: statusHash,
        byte_size: statusByteSize,
        storage_type: 'FILE',
        file_path: materializedStatusPath,
        raw_payload: null,
        created_at: phaseCNowIso,
      };
    }

    // 2. Git Diff Evidence
    let stagedGitDiffEvidence: Evidence | null = null;
    let diffEvId = '';
    let diffHash = '';
    let diffByteSize = 0;
    let materializedDiffPath = '';
    if (postGitDiff) {
      diffEvId = crypto.randomUUID();
      const diffContent = postGitDiff.diffContent ?? '';
      diffHash = computeSha256(diffContent);
      diffByteSize = Buffer.byteLength(diffContent, 'utf8');
      const mat = this.artifactStore.materializeContentAddressedFile(diffContent, diffHash);
      if (mat.newlyCreated) newlyMaterializedPaths.push(mat.filePath);
      materializedDiffPath = mat.filePath;
      stagedGitDiffEvidence = {
        id: diffEvId,
        project_id: sub.project_id,
        task_id: sub.task_id,
        attempt_id: snapshot.attempt_id,
        evidence_type: 'GIT_DIFF',
        summary: `Git Diff: ${postGitDiff.filesChanged?.length ?? 0} files changed`,
        content_type: 'text/x-diff',
        hash: diffHash,
        byte_size: diffByteSize,
        storage_type: 'FILE',
        file_path: materializedDiffPath,
        raw_payload: null,
        created_at: phaseCNowIso,
      };
    }

    // 3. Test Result Evidence
    const testResultEvId = crypto.randomUUID();
    const testResultPayload = canonicalJsonStringify({
      outcome: verificationResult.outcome,
      exit_code: verificationResult.exit_code,
      duration_ms: verificationResult.duration_ms,
      metrics: verificationResult.metrics,
      stdout: verificationResult.stdout,
      stderr: verificationResult.stderr,
    });
    const testResultHash = computeSha256(testResultPayload);
    const testResultByteSize = Buffer.byteLength(testResultPayload, 'utf8');
    const matTest = this.artifactStore.materializeContentAddressedFile(testResultPayload, testResultHash);
    if (matTest.newlyCreated) newlyMaterializedPaths.push(matTest.filePath);
    const testResultEvidence: Evidence = {
      id: testResultEvId,
      project_id: sub.project_id,
      task_id: sub.task_id,
      attempt_id: snapshot.attempt_id,
      evidence_type: 'TEST_RESULT',
      summary: `Test Execution Result: ${verificationResult.outcome} (exit ${verificationResult.exit_code})`,
      content_type: 'application/json',
      hash: testResultHash,
      byte_size: testResultByteSize,
      storage_type: 'FILE',
      file_path: matTest.filePath,
      raw_payload: null,
      created_at: phaseCNowIso,
    };

    const testRunId = crypto.randomUUID();
    const testRun: TestRun = {
      id: testRunId,
      task_id: sub.task_id,
      command: verificationResult.command,
      passed_count: verificationResult.metrics.passedCount,
      failed_count: verificationResult.metrics.failedCount,
      skipped_count: verificationResult.metrics.skippedCount,
      duration_ms: verificationResult.duration_ms,
      exit_code: verificationResult.exit_code,
      evidence_id: testResultEvId,
      created_at: phaseCNowIso,
    };

    // 4. Artifact Manifest
    const manifestEntries: ArtifactManifestEntry[] = [
      {
        byte_size: testResultByteSize,
        content_type: 'application/json',
        evidence_id: testResultEvId,
        evidence_type: 'TEST_RESULT',
        relative_path: path.relative(this.artifactStore.getBaseDir(), matTest.filePath).replace(/\\/g, '/'),
        sha256: testResultHash,
        storage_class: 'FILE',
      },
    ];
    if (stagedGitStatusEvidence) {
      manifestEntries.push({
        byte_size: statusByteSize,
        content_type: 'application/json',
        evidence_id: statusEvId,
        evidence_type: 'GIT_STATUS',
        relative_path: path.relative(this.artifactStore.getBaseDir(), materializedStatusPath).replace(/\\/g, '/'),
        sha256: statusHash,
        storage_class: 'FILE',
      });
    }
    if (stagedGitDiffEvidence) {
      manifestEntries.push({
        byte_size: diffByteSize,
        content_type: 'text/x-diff',
        evidence_id: diffEvId,
        evidence_type: 'GIT_DIFF',
        relative_path: path.relative(this.artifactStore.getBaseDir(), materializedDiffPath).replace(/\\/g, '/'),
        sha256: diffHash,
        storage_class: 'FILE',
      });
    }
    const manifestObj: ArtifactManifest = {
      adjudication_id: adjudicationId,
      entries: manifestEntries,
      lifecycle_version: 3,
      manifest_schema_version: 1,
      verification_execution_id: executionId,
    };
    const artifactManifestJson = canonicalizeArtifactManifest(manifestObj);
    const artifactManifestHash = computeArtifactManifestHash(artifactManifestJson);

    // =========================================================================
    // EXPLICIT PROCESS TRUTH & VERIFICATION TARGET STATUS
    // =========================================================================
    const isAmbiguous =
      verificationResult.outcome === 'RECOVERY_FENCED' ||
      verificationResult.process_start === 'START_AMBIGUOUS' ||
      verificationResult.process_termination === 'TERMINATION_UNRESOLVED';

    let targetStatus: AdjudicationStatus;
    let failureCode: string | null = null;
    let failureDetail: string | null = null;

    if (isAmbiguous) {
      targetStatus = 'RECOVERY_FENCED';
      let code = verificationResult.failure_code;
      if (!code || code === 'ORPHANED_VERIFICATION_INTERRUPTED') {
        if (verificationResult.process_start === 'START_AMBIGUOUS' || verificationResult.process_start === 'NOT_STARTED_PROVEN') {
          code = 'PROCESS_START_FAILED';
        } else if (verificationResult.process_termination === 'TERMINATION_UNRESOLVED') {
          code = 'PROCESS_TERMINATION_UNRESOLVED';
        } else {
          code = 'ORPHANED_VERIFICATION_INTERRUPTED';
        }
      }
      failureCode = code;
      failureDetail = verificationResult.error || verificationResult.reason || 'Process execution ambiguous';
    } else if (driftDetected) {
      targetStatus = 'VERIFICATION_FAILED';
      failureCode = 'WORKTREE_DRIFT';
      failureDetail = driftReason;
    } else if (verificationResult.outcome === 'SUCCESS' && verificationResult.exit_code === 0) {
      targetStatus = 'VERIFIED';
    } else if (verificationResult.outcome === 'TEST_FAILED') {
      targetStatus = 'VERIFICATION_FAILED';
      failureCode = 'TESTS_FAILED';
      failureDetail = `Test run failed with exit code ${verificationResult.exit_code}`;
    } else if (verificationResult.outcome === 'TEST_TIMEOUT') {
      targetStatus = 'VERIFICATION_FAILED';
      failureCode = 'VERIFICATION_TIMEOUT';
      failureDetail = `Test execution timed out after ${verificationResult.duration_ms}ms`;
    } else if (verificationResult.outcome === 'COMMAND_POLICY_REJECTED') {
      targetStatus = 'VERIFICATION_FAILED';
      failureCode = 'POLICY_VIOLATION';
      failureDetail = verificationResult.reason || 'Command policy rejected';
    } else if (verificationResult.outcome === 'PROCESS_START_FAILED') {
      targetStatus = 'VERIFICATION_FAILED';
      failureCode = 'PROCESS_START_FAILED';
      failureDetail = verificationResult.error || 'Failed to start process';
    } else {
      targetStatus = 'VERIFICATION_FAILED';
      failureCode = 'TESTS_FAILED';
      failureDetail = `Unexpected verification outcome: ${verificationResult.outcome}`;
    }

    const scrubbedFailureDetail = failureDetail ? scrubAdjudicationDiagnostics(failureDetail) : null;

    const exitClassification =
      verificationResult.exit_code === 0
        ? 'EXIT_ZERO'
        : verificationResult.timed_out
        ? 'TIMEOUT'
        : verificationResult.exit_code > 0
        ? 'EXIT_NONZERO'
        : 'UNKNOWN';

    const processStartClass: 'SPAWNED_PROVEN' | 'LAUNCH_FAILED_PROVEN' | 'NOT_STARTED_PROVEN' =
      verificationResult.process_start === 'STARTED_PROVEN'
        ? 'SPAWNED_PROVEN'
        : verificationResult.process_start === 'NOT_STARTED_PROVEN'
        ? 'NOT_STARTED_PROVEN'
        : 'LAUNCH_FAILED_PROVEN';

    const terminationClass: 'TERMINATION_PROVEN' | 'TERMINATION_AMBIGUOUS' | 'NOT_APPLICABLE' =
      verificationResult.process_termination === 'PROCESS_TREE_TERMINATED_PROVEN'
        ? 'TERMINATION_PROVEN'
        : verificationResult.process_termination === 'NOT_APPLICABLE'
        ? 'NOT_APPLICABLE'
        : 'TERMINATION_AMBIGUOUS';

    const afterEvidenceHash = stagedGitStatusEvidence?.hash ?? stagedGitDiffEvidence?.hash ?? testResultHash;

    const resultEnvelope: CanonicalVerificationResultEnvelope = {
      adjudication_id: adjudicationId,
      artifact_manifest_hash: artifactManifestHash,
      assignment_id: snapshot.assignment_id,
      attempt_id: snapshot.attempt_id,
      authorization_id: sub.authorization_id,
      command_snapshot_hash: verificationCommandsHash,
      exit_classification: exitClassification,
      failure_code: failureCode,
      failure_payload: failureCode
        ? isAmbiguous
          ? {
              error: scrubbedFailureDetail || 'Process execution ambiguous',
              is_fenced: true,
            }
          : {
              error: scrubbedFailureDetail || 'Verification failed',
            }
        : null,
      finish_timestamp: phaseCNowIso,
      git_diff_evidence_hash: stagedGitDiffEvidence?.hash ?? '',
      git_diff_evidence_id: stagedGitDiffEvidence?.id ?? '',
      git_status_evidence_hash: stagedGitStatusEvidence?.hash ?? '',
      git_status_evidence_id: stagedGitStatusEvidence?.id ?? '',
      lifecycle_version: 3,
      process_start_classification: processStartClass,
      project_id: sub.project_id,
      start_timestamp: phaseBNowIso,
      task_id: sub.task_id,
      task_ownership_epoch: sub.task_ownership_epoch,
      termination_classification: terminationClass,
      test_result_evidence_hash: testResultHash,
      test_result_evidence_id: testResultEvId,
      test_run_id: testRunId,
      verification_execution_id: executionId,
      workspace_snapshot_after_hash: afterEvidenceHash,
      workspace_snapshot_before_hash: workspaceSnapshotHash,
    };
    const resultEnvelopeJson = canonicalJsonStringify(resultEnvelope);
    const resultEnvelopeHash = computeSha256(resultEnvelopeJson);

    // =========================================================================
    // PHASE C: SETTLEMENT TRANSACTION (Single Atomic BEGIN IMMEDIATE)
    // =========================================================================
    let finalAdjudication: CoderSubmissionAdjudication | null = null;

    try {
      this.repo.runInTransaction(() => {
        const currentSub = this.repo.getCoderSubmissionById(sub.id);
        if (!currentSub) {
          throw new Error(`Submission ${sub.id} missing during settlement`);
        }
        const liveIntegrity = this.validateSubmissionAndAuthorityIntegrity(currentSub);
        if (!liveIntegrity.valid) {
          throw new CoderSubmissionAdjudicationError(
            'STATUS_CONFLICT',
            `Phase C authority verification failed: ${liveIntegrity.fenced_reasons.join('; ')}`
          );
        }

        const currentAdj = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
        if (!currentAdj) {
          throw new Error(`Adjudication ${adjudicationId} missing during settlement`);
        }
        if (currentAdj.status !== 'VERIFYING') {
          throw new CoderSubmissionAdjudicationError(
            'STATUS_CONFLICT',
            `Expected adjudication status VERIFYING, got ${currentAdj.status}`
          );
        }
        if (currentAdj.lifecycle_version !== 2) {
          throw new CoderSubmissionAdjudicationError(
            'STATUS_CONFLICT',
            `Expected adjudication lifecycle version 2, got ${currentAdj.lifecycle_version}`
          );
        }
        if (currentAdj.verification_execution_id !== executionId) {
          throw new CoderSubmissionAdjudicationError(
            'STATUS_CONFLICT',
            'Verification execution ID mismatch during settlement'
          );
        }

        const currentTask = this.repo.getTask(sub.task_id);
        if (!currentTask) {
          throw new Error(`Task ${sub.task_id} missing during settlement`);
        }

        const liveLease = this.repo.getWorkspaceLease(leaseId);
        if (!liveLease || liveLease.state !== 'VERIFYING' || liveLease.execution_id !== executionId || liveLease.released_at !== null) {
          throw new CoderSubmissionAdjudicationError(
            'STATUS_CONFLICT',
            `Workspace lease ${leaseId} state conflict or execution mismatch in settlement`
          );
        }

        // Re-verify evidence file bytes on disk before database write
        const testCheck = verifyEvidenceIntegrity(testResultEvidence, this.artifactStore);
        if (!testCheck.valid) {
          throw new Error(`Test result evidence file integrity check failed: ${testCheck.reason}`);
        }
        if (stagedGitStatusEvidence) {
          const sc = verifyEvidenceIntegrity(stagedGitStatusEvidence, this.artifactStore);
          if (!sc.valid) {
            throw new Error(`Git status evidence file integrity check failed: ${sc.reason}`);
          }
        }
        if (stagedGitDiffEvidence) {
          const dc = verifyEvidenceIntegrity(stagedGitDiffEvidence, this.artifactStore);
          if (!dc.valid) {
            throw new Error(`Git diff evidence file integrity check failed: ${dc.reason}`);
          }
        }

        // Insert evidence rows
        this.repo.createEvidence(testResultEvidence);
        if (stagedGitStatusEvidence) {
          this.repo.createEvidence(stagedGitStatusEvidence);
        }
        if (stagedGitDiffEvidence) {
          this.repo.createEvidence(stagedGitDiffEvidence);
        }

        // Insert test run
        this.repo.createTestRun(testRun);

        const decision = evaluateCanonicalSettlementDecision({
          rawEnvelopeJson: resultEnvelopeJson,
          storedEnvelopeHash: resultEnvelopeHash,
          rawManifestJson: artifactManifestJson,
          storedManifestHash: artifactManifestHash,
          adjudication: currentAdj,
          testRun,
          gitStatusEvidenceId: stagedGitStatusEvidence?.id ?? null,
          gitDiffEvidenceId: stagedGitDiffEvidence?.id ?? null,
          testResultEvidenceId: testResultEvidence.id,
          repo: this.repo,
          artifactStore: this.artifactStore,
        });

        targetStatus = decision.targetStatus;
        const isSuccess = decision.isSuccess;
        failureCode = decision.failureCode;
        const effectiveFailureDetail = decision.failureDetail ? scrubAdjudicationDiagnostics(decision.failureDetail) : null;
        const eventType = decision.eventType;
        const eventPayload = isSuccess
          ? canonicalJsonStringify({
              adjudication_id: adjudicationId,
              exit_code: 0,
              test_run_id: testRunId,
            })
          : canonicalJsonStringify({
              adjudication_id: adjudicationId,
              error: effectiveFailureDetail,
              failure_code: failureCode || 'TESTS_FAILED',
            });

        const eventPayloadHash = computeSha256(eventPayload);
        const finalEventId = deriveDeterministicAdjudicationEventId(
          adjudicationId,
          3,
          eventType,
          eventPayloadHash
        );
        const genericFinalEventId = deriveDeterministicGenericAdjudicationEventId(
          adjudicationId,
          3,
          eventType,
          eventPayloadHash
        );

        const dispositionId = deriveDeterministicDispositionId(sub.id, adjudicationId, 3);

        if (targetStatus === 'VERIFIED') {
          // Authoritative Success Path:
          // Transition task: VALIDATING -> REVIEW_READY
          const trans = TaskStateMachine.transition(currentTask.state, 'EVIDENCE_GATHERED', {
            revisionCount: currentTask.revision_count,
            maxRevisions: currentTask.max_revisions,
          });

          this.repo.updateTaskState(currentTask.id, trans.nextState);
          this.repo.updateTaskShas(
            currentTask.id,
            sub.base_sha,
            postObservation ? postObservation.head_sha : null
          );

          // Append terminal disposition: SETTLED / ACCEPTED_VERIFIED
          const disposition: CoderSubmissionDisposition = {
            id: dispositionId,
            submission_id: sub.id,
            disposition_event: 'SETTLED',
            disposition_reason: 'ACCEPTED_VERIFIED',
            actor_type: 'OPERATOR',
            actor_id: 'OWNER_LOCAL_UI',
            disposition_metadata_json: canonicalJsonStringify({
              adjudication_id: adjudicationId,
              exit_code: 0,
              test_run_id: testRunId,
            }),
            created_at: phaseCNowIso,
          };
          this.repo.createCoderSubmissionDisposition(disposition);

          // Update adjudication: VERIFIED (CAS version 2 -> 3)
          const updated = this.repo.updateCoderSubmissionAdjudication(adjudicationId, 2, {
            status: 'VERIFIED',
            test_run_id: testRunId,
            git_status_evidence_id: stagedGitStatusEvidence?.id ?? null,
            git_diff_evidence_id: stagedGitDiffEvidence?.id ?? null,
            completed_at: phaseCNowIso,
            verification_result_envelope_json: resultEnvelopeJson,
            verification_result_envelope_hash: resultEnvelopeHash,
            artifact_manifest_json: artifactManifestJson,
            artifact_manifest_hash: artifactManifestHash,
          });

          if (!updated) {
            throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Settlement CAS failed (expected version 2)');
          }

          // Release workspace lease
          const leaseUpdated = this.repo.updateWorkspaceLease(liveLease.id, liveLease.lifecycle_version, {
            state: 'RELEASED',
            released_at: phaseCNowIso,
          });
          if (!leaseUpdated) {
            throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Workspace lease release CAS failed');
          }

          // Create deterministic events atomically
          this.repo.createCoderSubmissionAdjudicationEvent({
            id: finalEventId,
            adjudication_id: adjudicationId,
            sequence: 3,
            event_type: 'VERIFICATION_SUCCEEDED',
            payload_json: eventPayload,
            payload_hash: eventPayloadHash,
            created_at: phaseCNowIso,
          });

          this.repo.createDeterministicGenericEvent({
            id: genericFinalEventId,
            project_id: sub.project_id,
            task_id: sub.task_id,
            agent_id: null,
            type: 'CODER_SUBMISSION_VERIFIED',
            summary: `Quarantined submission ${sub.id} successfully verified. Task advanced to REVIEW_READY.`,
            structured_payload: { adjudicationId, submissionId: sub.id, testRunId },
            timestamp: phaseCNowIso,
          });
        } else if (targetStatus === 'VERIFICATION_FAILED') {
          // Authoritative Failure Path:
          const trans = TaskStateMachine.transition(currentTask.state, 'TESTS_FAILED', {
            revisionCount: currentTask.revision_count,
            maxRevisions: currentTask.max_revisions,
          });

          this.repo.updateTaskState(currentTask.id, trans.nextState, null, trans.incrementRevision);

          // Update adjudication: VERIFICATION_FAILED (CAS version 2 -> 3)
          const updated = this.repo.updateCoderSubmissionAdjudication(adjudicationId, 2, {
            status: 'VERIFICATION_FAILED',
            test_run_id: testRunId,
            git_status_evidence_id: stagedGitStatusEvidence?.id ?? null,
            git_diff_evidence_id: stagedGitDiffEvidence?.id ?? null,
            failure_code: failureCode || 'TESTS_FAILED',
            failure_json: canonicalJsonStringify({ error: scrubbedFailureDetail }),
            completed_at: phaseCNowIso,
            verification_result_envelope_json: resultEnvelopeJson,
            verification_result_envelope_hash: resultEnvelopeHash,
            artifact_manifest_json: artifactManifestJson,
            artifact_manifest_hash: artifactManifestHash,
          });

          if (!updated) {
            throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Settlement CAS failed (expected version 2)');
          }

          // Release workspace lease
          const leaseUpdated = this.repo.updateWorkspaceLease(liveLease.id, liveLease.lifecycle_version, {
            state: 'RELEASED',
            released_at: phaseCNowIso,
          });
          if (!leaseUpdated) {
            throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Workspace lease release CAS failed');
          }

          this.repo.createCoderSubmissionAdjudicationEvent({
            id: finalEventId,
            adjudication_id: adjudicationId,
            sequence: 3,
            event_type: 'VERIFICATION_FAILED',
            payload_json: eventPayload,
            payload_hash: eventPayloadHash,
            created_at: phaseCNowIso,
          });

          this.repo.createDeterministicGenericEvent({
            id: genericFinalEventId,
            project_id: sub.project_id,
            task_id: sub.task_id,
            agent_id: null,
            type: 'CODER_SUBMISSION_VERIFICATION_FAILED',
            summary: `Quarantined submission ${sub.id} verification failed (${failureCode}): ${scrubbedFailureDetail}. Task state: ${trans.nextState}.`,
            structured_payload: { adjudicationId, error: scrubbedFailureDetail, failureCode, submissionId: sub.id },
            timestamp: phaseCNowIso,
          });
        } else {
          // RECOVERY_FENCED Path:
          const trans = TaskStateMachine.transition(currentTask.state, 'TESTS_FAILED', {
            revisionCount: currentTask.revision_count,
            maxRevisions: currentTask.max_revisions,
          });
          this.repo.updateTaskState(currentTask.id, trans.nextState, null, trans.incrementRevision);

          const updated = this.repo.updateCoderSubmissionAdjudication(adjudicationId, 2, {
            status: 'RECOVERY_FENCED',
            test_run_id: testRunId,
            git_status_evidence_id: stagedGitStatusEvidence?.id ?? null,
            git_diff_evidence_id: stagedGitDiffEvidence?.id ?? null,
            failure_code: failureCode || 'ORPHANED_VERIFICATION_INTERRUPTED',
            failure_json: canonicalJsonStringify({ error: scrubbedFailureDetail }),
            recovery_fenced_at: phaseCNowIso,
            verification_result_envelope_json: resultEnvelopeJson,
            verification_result_envelope_hash: resultEnvelopeHash,
            artifact_manifest_json: artifactManifestJson,
            artifact_manifest_hash: artifactManifestHash,
          });

          if (!updated) {
            throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Settlement CAS failed (expected version 2)');
          }

          // Fence workspace lease
          const leaseUpdated = this.repo.updateWorkspaceLease(liveLease.id, liveLease.lifecycle_version, {
            state: 'FENCED',
            failure_code: failureCode || 'ORPHANED_VERIFICATION_INTERRUPTED',
            failure_evidence_hash: artifactManifestHash,
          });
          if (!leaseUpdated) {
            throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Workspace lease fencing CAS failed');
          }

          this.repo.createCoderSubmissionAdjudicationEvent({
            id: finalEventId,
            adjudication_id: adjudicationId,
            sequence: 3,
            event_type: 'RECOVERY_FENCED',
            payload_json: eventPayload,
            payload_hash: eventPayloadHash,
            created_at: phaseCNowIso,
          });

          this.repo.createDeterministicGenericEvent({
            id: genericFinalEventId,
            project_id: sub.project_id,
            task_id: sub.task_id,
            agent_id: null,
            type: 'CODER_SUBMISSION_RECOVERY_FENCED',
            summary: `Quarantined submission ${sub.id} recovery-fenced (${failureCode}): ${scrubbedFailureDetail}.`,
            structured_payload: { adjudicationId, error: scrubbedFailureDetail, failureCode, submissionId: sub.id },
            timestamp: phaseCNowIso,
          });
        }

        finalAdjudication = this.repo.getCoderSubmissionAdjudicationById(adjudicationId)!;
      });
    } catch (err) {
      // Rollback cleanup: clean newly materialized unreferenced files
      const cleanupRes = this.artifactStore.cleanupRollbackFiles(
        newlyMaterializedPaths,
        (fp) => this.repo.isEvidenceFilePathReferenced(fp)
      );
      if (cleanupRes.failures.length > 0) {
        try {
          this.repo.runInTransaction(() => {
            const currentAdj = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
            if (currentAdj && currentAdj.status === 'VERIFYING') {
              this.repo.updateCoderSubmissionAdjudication(adjudicationId, currentAdj.lifecycle_version, {
                status: 'RECOVERY_FENCED',
                failure_code: 'CLEANUP_DEBT_FENCED',
                failure_json: canonicalJsonStringify({ error: 'Artifact cleanup failed during rollback' }),
                recovery_fenced_at: new Date().toISOString(),
                artifact_manifest_json: artifactManifestJson,
                artifact_manifest_hash: artifactManifestHash,
              });
              const liveLease = this.repo.getWorkspaceLease(leaseId);
              if (liveLease && liveLease.released_at === null) {
                this.repo.updateWorkspaceLease(liveLease.id, liveLease.lifecycle_version, {
                  state: 'FENCED',
                  failure_code: 'CLEANUP_DEBT_FENCED',
                  failure_evidence_hash: artifactManifestHash,
                });
              }
            }
          });
        } catch (debtErr: unknown) {
          const debtMsg = debtErr instanceof Error ? debtErr.message : String(debtErr);
          const primaryMsg = err instanceof Error ? err.message : String(err);
          throw new Error(`PHASE_C_ROLLBACK_AND_CLEANUP_DEBT_FAILURE: Primary error: [${primaryMsg}]. Cleanup debt fencing failed: [${debtMsg}].`);
        }
      }
      throw err;
    }

    return {
      adjudication: finalAdjudication!,
      status: finalAdjudication!.status,
    };
  }

  /**
   * Resumes an ADMITTED submission that was safe pre-start.
   */
  public async resumeAdmittedSubmission(params: {
    requestId: string;
    submissionId: string;
    adjudicationId: string;
    expectedLifecycleVersion: number;
  }): Promise<{ adjudication: CoderSubmissionAdjudication; status: AdjudicationStatus }> {
    const adj = this.repo.getCoderSubmissionAdjudicationById(params.adjudicationId);
    if (!adj) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `No adjudication found with ID "${params.adjudicationId}"`
      );
    }
    if (adj.submission_id !== params.submissionId) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication "${params.adjudicationId}" does not belong to submission "${params.submissionId}"`
      );
    }
    if (adj.status !== 'ADMITTED') {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication is in status "${adj.status}", only "ADMITTED" can be resumed`
      );
    }
    if (adj.verification_execution_id !== null || adj.verification_started_at !== null) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        'Cannot resume adjudication that already has an execution claim'
      );
    }
    if (adj.lifecycle_version !== params.expectedLifecycleVersion) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication lifecycle version mismatch: expected ${params.expectedLifecycleVersion}, actual ${adj.lifecycle_version}`
      );
    }

    return this.admitSubmissionForVerification({
      requestId: params.requestId,
      submissionId: params.submissionId,
      resumeAdjudicationId: adj.id,
    });
  }

  /**
   * Acknowledges a RECOVERY_FENCED submission without rerunning it.
   */
  public acknowledgeRecoveryFenced(params: {
    requestId: string;
    submissionId: string;
    adjudicationId: string;
    expectedLifecycleVersion: number;
    decision: 'ACKNOWLEDGE' | 'CANCEL';
    resolverId?: string;
  }): { adjudication: CoderSubmissionAdjudication } {
    const adj = this.repo.getCoderSubmissionAdjudicationById(params.adjudicationId);
    if (!adj) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `No adjudication found with ID "${params.adjudicationId}"`
      );
    }
    if (adj.submission_id !== params.submissionId) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication "${params.adjudicationId}" does not belong to submission "${params.submissionId}"`
      );
    }

    // Idempotency: If already resolved with the same decision
    if (adj.resolution_action === params.decision) {
      if (params.decision === 'CANCEL' && adj.status === 'VERIFICATION_FAILED') {
        return { adjudication: adj };
      }
      if (params.decision === 'ACKNOWLEDGE' && adj.status === 'RECOVERY_FENCED') {
        return { adjudication: adj };
      }
    }

    if (adj.status !== 'RECOVERY_FENCED') {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication is in status "${adj.status}", expected "RECOVERY_FENCED"`
      );
    }
    if (adj.lifecycle_version !== params.expectedLifecycleVersion) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication lifecycle version mismatch: expected ${params.expectedLifecycleVersion}, actual ${adj.lifecycle_version}`
      );
    }

    const nextStatus = params.decision === 'CANCEL' ? 'VERIFICATION_FAILED' : 'RECOVERY_FENCED';
    const nowIso = new Date().toISOString();
    const resolverId = params.resolverId ?? params.requestId;

    const payloadJson = canonicalJsonStringify({
      acknowledged_at: nowIso,
      decision: params.decision,
      resolver_id: resolverId,
      original_failure_code: adj.failure_code,
    });
    const payloadHash = computeSha256(payloadJson);
    const eventType = params.decision === 'CANCEL' ? 'VERIFICATION_FAILED' : 'RECOVERY_FENCED';

    const eventId = deriveDeterministicAdjudicationEventId(
      adj.id,
      adj.lifecycle_version + 1,
      eventType,
      payloadHash
    );
    const genericEventId = deriveDeterministicGenericAdjudicationEventId(
      adj.id,
      adj.lifecycle_version + 1,
      eventType,
      payloadHash
    );

    this.repo.runInTransaction(() => {
      // NEVER clear verification_execution_id or verification_started_at or recovery_fenced_at!
      // Preserves original failure_code! Populates the 5 resolution columns.
      const updated = this.repo.updateCoderSubmissionAdjudication(adj.id, adj.lifecycle_version, {
        status: nextStatus,
        failure_code: adj.failure_code,
        completed_at: params.decision === 'CANCEL' ? nowIso : null,
        recovery_fenced_at: adj.recovery_fenced_at, // IMMUTABLE
        resolution_action: params.decision,
        resolution_timestamp: nowIso,
        resolution_evidence_json: payloadJson,
        resolution_evidence_hash: payloadHash,
        resolver_id: resolverId,
      });

      if (!updated) {
        throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Failed to update recovery fenced status (CAS mismatch)');
      }

      const seq = this.repo.getNextAdjudicationEventSequence(adj.id);
      this.repo.createCoderSubmissionAdjudicationEvent({
        id: eventId,
        adjudication_id: adj.id,
        sequence: seq,
        event_type: eventType,
        payload_json: payloadJson,
        payload_hash: payloadHash,
        created_at: nowIso,
      });

      this.repo.createDeterministicGenericEvent({
        id: genericEventId,
        project_id: adj.project_id,
        task_id: adj.task_id,
        agent_id: null,
        type: params.decision === 'CANCEL' ? 'CODER_SUBMISSION_RECOVERY_CANCELLED' : 'CODER_SUBMISSION_RECOVERY_ACKNOWLEDGED',
        summary: `Recovery fenced adjudication ${adj.id} acknowledged by Owner: ${params.decision}`,
        structured_payload: { adjudicationId: adj.id, decision: params.decision, acknowledgedAt: nowIso, resolverId },
        timestamp: nowIso,
      });

      if (params.decision === 'CANCEL') {
        const liveTask = this.repo.getTask(adj.task_id);
        if (liveTask && (liveTask.state === 'VALIDATING' || liveTask.state === 'CODING' || liveTask.state === 'BLOCKED')) {
          const trans = TaskStateMachine.transition(liveTask.state, 'CANCEL', {
            revisionCount: liveTask.revision_count,
            maxRevisions: liveTask.max_revisions,
          });
          this.repo.updateTaskState(liveTask.id, trans.nextState);
        }
      }
    });

    const updatedAdj = this.repo.getCoderSubmissionAdjudicationById(adj.id)!;
    return { adjudication: updatedAdj };
  }

  /**
   * Pure, authoritative projection builder for review packages.
   */
  public buildVerifiedAdjudicationReviewProjection(adjudicationId: string): VerifiedAdjudicationReviewProjection {
    const adj = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
    if (!adj) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Adjudication "${adjudicationId}" not found`);
    }

    const sub = this.repo.getCoderSubmissionById(adj.submission_id);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission "${adj.submission_id}" not found`);
    }

    const integrity = this.validateSubmissionAndAuthorityIntegrity(sub);
    if (!integrity.valid) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Submission authority integrity failed: ${integrity.fenced_reasons.join('; ')}`
      );
    }

    const project = this.repo.getProject(adj.project_id);
    if (!project) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Project "${adj.project_id}" not found`);
    }

    const task = this.repo.getTask(adj.task_id);
    if (!task) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Task "${adj.task_id}" not found`);
    }

    // Snapshot and command validation: reject empty {} snapshots
    if (!adj.authority_snapshot_json || adj.authority_snapshot_json.trim() === '{}') {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Adjudication authority snapshot cannot be empty: ${adj.id}`
      );
    }
    try {
      const snap = JSON.parse(adj.authority_snapshot_json);
      if (typeof snap !== 'object' || snap === null || Array.isArray(snap) || Object.keys(snap).length === 0) {
        throw new Error('empty or invalid');
      }
    } catch (snapErr: unknown) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Adjudication authority snapshot is malformed or empty: ${adj.id}`
      );
    }

    if (adj.action === 'ADMIT_VERIFICATION' && (!adj.verification_commands_json || adj.verification_commands_json.trim() === '{}')) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Adjudication verification commands snapshot cannot be empty: ${adj.id}`
      );
    }
    if (adj.verification_commands_json) {
      try {
        const cmdSnap = JSON.parse(adj.verification_commands_json);
        if (typeof cmdSnap !== 'object' || cmdSnap === null || Array.isArray(cmdSnap) || Object.keys(cmdSnap).length === 0) {
          throw new Error('empty or invalid');
        }
      } catch (cmdErr: unknown) {
        throw new CoderSubmissionAdjudicationError(
          'INTEGRITY_CONFLICT',
          `Adjudication verification commands snapshot is malformed or empty: ${adj.id}`
        );
      }
    }

    // Acceptance criteria
    const taskRecord = task as unknown as Record<string, unknown>;
    const acceptance_criteria = Array.isArray(task.acceptance_criteria)
      ? task.acceptance_criteria
      : (typeof taskRecord.acceptance_criteria_json === 'string'
          ? (JSON.parse(taskRecord.acceptance_criteria_json) as string[])
          : []);

    // Previous issues
    const reviews = this.repo.getReviewsByTask(task.id);
    const previous_issues = reviews.flatMap((r) => r.issues || []);

    // Untrusted coder claim
    const rawClaim = integrity.parsed_claim;
    const untrusted_claim = {
      summary: (rawClaim.summary as string) || sub.summary || '',
      completed: Array.isArray(rawClaim.completed) ? (rawClaim.completed as string[]) : [],
      files_claimed_changed: Array.isArray(rawClaim.files_claimed_changed) ? (rawClaim.files_claimed_changed as string[]) : [],
      tests_claimed: Array.isArray(rawClaim.tests_claimed) ? (rawClaim.tests_claimed as string[]) : [],
      blockers: Array.isArray(rawClaim.blockers) ? (rawClaim.blockers as string[]) : [],
      claim_content_hash: sub.claim_content_hash,
    };

    // Authoritative verification / test run
    let testRun: TestRun | null = null;
    let testResultEv: Evidence | null = null;
    if (adj.test_run_id) {
      testRun = this.repo.getTestRun(adj.test_run_id);
      if (testRun?.evidence_id) {
        testResultEv = this.repo.getEvidence(testRun.evidence_id);
      }
    }

    let authoritative_verification: VerifiedAdjudicationReviewProjection['authoritative_verification'];
    if (testRun) {
      if (testResultEv) {
        const evValid = verifyEvidenceIntegrity(testResultEv, this.artifactStore);
        if (!evValid.valid) {
          throw new CoderSubmissionAdjudicationError('INTEGRITY_CONFLICT', `Test result evidence integrity failed: ${evValid.reason}`);
        }
      }

      let verdict: 'PASSED' | 'FAILED' | 'TIMEOUT' | 'FENCED' | 'NOT_RUN' = 'FAILED';
      if (adj.status === 'VERIFIED') verdict = 'PASSED';
      else if (adj.status === 'RECOVERY_FENCED') verdict = 'FENCED';
      else if (adj.failure_code === 'TEST_EXECUTION_TIMEOUT' || adj.failure_code === 'TEST_TIMEOUT') verdict = 'TIMEOUT';
      else if (adj.status === 'VERIFICATION_FAILED') verdict = 'FAILED';

      authoritative_verification = {
        test_run_id: testRun.id,
        command: testRun.command,
        command_snapshot_hash: adj.verification_commands_hash ?? null,
        exit_code: testRun.exit_code,
        passed_count: testRun.passed_count,
        failed_count: testRun.failed_count,
        skipped_count: testRun.skipped_count,
        duration_ms: testRun.duration_ms,
        test_result_evidence_id: testRun.evidence_id ?? null,
        test_result_evidence_hash: testResultEv?.hash ?? null,
        verdict,
      };
    } else {
      let verdict: 'PASSED' | 'FAILED' | 'TIMEOUT' | 'FENCED' | 'NOT_RUN' = 'NOT_RUN';
      if (adj.status === 'RECOVERY_FENCED') verdict = 'FENCED';
      else if (adj.status === 'VERIFICATION_FAILED') verdict = 'FAILED';

      authoritative_verification = {
        test_run_id: null,
        command: null,
        command_snapshot_hash: adj.verification_commands_hash ?? null,
        exit_code: null,
        passed_count: 0,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 0,
        test_result_evidence_id: null,
        test_result_evidence_hash: null,
        verdict,
      };
    }

    // Git Status Evidence
    let authoritative_git_status: VerifiedAdjudicationReviewProjection['authoritative_git_status'] = null;
    if (adj.git_status_evidence_id) {
      const statusEv = this.repo.getEvidence(adj.git_status_evidence_id);
      if (statusEv) {
        const evValid = verifyEvidenceIntegrity(statusEv, this.artifactStore);
        if (!evValid.valid) {
          throw new CoderSubmissionAdjudicationError('INTEGRITY_CONFLICT', `Git status evidence integrity failed: ${evValid.reason}`);
        }
        let payloadStr = statusEv.raw_payload ?? '';
        if (statusEv.storage_type === 'FILE' && statusEv.file_path) {
          payloadStr = fs.readFileSync(path.resolve(this.artifactStore.getBaseDir(), statusEv.file_path), 'utf8');
        }
        let parsedPayload: Record<string, unknown>;
        try {
          parsedPayload = JSON.parse(payloadStr);
          if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) {
            throw new Error('Not an object');
          }
        } catch (statusErr: unknown) {
          throw new CoderSubmissionAdjudicationError(
            'INTEGRITY_CONFLICT',
            `Git status evidence payload is malformed JSON`
          );
        }

        if ('is_clean' in parsedPayload) {
          throw new CoderSubmissionAdjudicationError(
            'INTEGRITY_CONFLICT',
            `Git status evidence contains forbidden alias 'is_clean'`
          );
        }
        if (typeof parsedPayload.isClean !== 'boolean') {
          throw new CoderSubmissionAdjudicationError(
            'INTEGRITY_CONFLICT',
            `Git status evidence missing required boolean 'isClean'`
          );
        }
        if (Array.isArray(parsedPayload.files)) {
          for (const f of parsedPayload.files) {
            if (typeof f === 'string') {
              if (path.isAbsolute(f) || f.includes('..') || f.startsWith('/') || f.startsWith('\\')) {
                throw new CoderSubmissionAdjudicationError(
                  'INTEGRITY_CONFLICT',
                  `Git status evidence contains invalid path traversal or absolute path: ${f}`
                );
              }
            }
          }
        }

        authoritative_git_status = {
          evidence_id: statusEv.id,
          evidence_hash: statusEv.hash,
          storage_type: statusEv.storage_type,
          is_clean: parsedPayload.isClean,
          branch: (parsedPayload.branch as string | null | undefined) ?? null,
          summary: (parsedPayload.summary as string | null | undefined) ?? payloadStr,
        };
      }
    }

    // Git Diff Evidence
    let authoritative_git_diff: VerifiedAdjudicationReviewProjection['authoritative_git_diff'] = null;
    if (adj.git_diff_evidence_id) {
      const diffEv = this.repo.getEvidence(adj.git_diff_evidence_id);
      if (diffEv) {
        const evValid = verifyEvidenceIntegrity(diffEv, this.artifactStore);
        if (!evValid.valid) {
          throw new CoderSubmissionAdjudicationError('INTEGRITY_CONFLICT', `Git diff evidence integrity failed: ${evValid.reason}`);
        }
        let diffContent = diffEv.raw_payload ?? '';
        if (diffEv.storage_type === 'FILE' && diffEv.file_path) {
          diffContent = fs.readFileSync(path.resolve(this.artifactStore.getBaseDir(), diffEv.file_path), 'utf8');
        }
        authoritative_git_diff = {
          evidence_id: diffEv.id,
          evidence_hash: diffEv.hash,
          storage_type: diffEv.storage_type,
          byte_size: diffEv.byte_size,
          diff_content: diffContent,
          is_truncated: diffContent.length > 32 * 1024,
        };
      }
    }

    // Recovery Fencing State
    const recovery_fencing_state: VerifiedAdjudicationReviewProjection['recovery_fencing_state'] = {
      is_fenced: adj.status === 'RECOVERY_FENCED' || adj.recovery_fenced_at !== null,
      status: adj.status,
      failure_code: adj.failure_code ?? null,
      recovery_fenced_at: adj.recovery_fenced_at ?? null,
      resolution_action: adj.resolution_action ?? null,
    };

    // Operator Disposition
    const disps = this.repo.getCoderSubmissionDispositions(adj.submission_id);
    const terminalDisps = disps.filter(
      (d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED'
    );
    if (terminalDisps.length > 1) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Ambiguous terminal dispositions: multiple terminal dispositions found for submission ${sub.id}`
      );
    }
    const terminalDisp = terminalDisps.length === 1 ? terminalDisps[0] : null;
    if (terminalDisps.length === 0 && (adj.status === 'VERIFIED' || adj.status === 'REJECTED' || adj.status === 'SUPERSEDED')) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Missing expected terminal disposition for settled adjudication status "${adj.status}"`
      );
    }
    const operator_disposition: VerifiedAdjudicationReviewProjection['operator_disposition'] = terminalDisp
      ? {
          disposition_event: terminalDisp.disposition_event,
          disposition_reason: terminalDisp.disposition_reason,
          decided_at: terminalDisp.created_at,
        }
      : null;

    const baseProjection = {
      adjudication_id: adj.id,
      submission_id: sub.id,
      project_id: project.id,
      project_name: project.name,
      task_id: task.id,
      task_title: task.title,
      task_priority: task.priority,
      task_risk: task.risk,
      task_revision_count: task.revision_count,
      task_max_revisions: task.max_revisions,
      task_base_sha: task.base_sha || 'HEAD',
      task_working_sha: task.current_sha || 'UNCOMMITTED',
      acceptance_criteria,
      previous_issues: previous_issues.map((iss) => ({
        severity: iss.severity,
        title: iss.title,
        file_path: iss.file_path ?? undefined,
        description: iss.description,
      })),
      untrusted_claim,
      authoritative_verification,
      authoritative_git_status,
      authoritative_git_diff,
      recovery_fencing_state,
      operator_disposition,
    };

    const projectionHash = computeSha256(canonicalJsonStringify(baseProjection));

    return {
      ...baseProjection,
      projection_hash: projectionHash,
    };
  }

  /**
   * One shared, typed, fail-closed integrity verifier used by list/inspect, admission,
   * claim, settlement, recovery, and review-package generation.
   */
  public validateSubmissionAndAuthorityIntegrity(
    sub: CoderSubmission
  ): SubmissionAuthorityIntegrityResult {
    const fenced_reasons: string[] = [];

    // 1. Parse stored JSON strictly as a non-null plain object (never array)
    let parsedClaim: Record<string, unknown> | null = null;
    let parsedEnvelope: Record<string, unknown> | null = null;

    try {
      const p = JSON.parse(sub.claim_content_json);
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
        parsedClaim = p as Record<string, unknown>;
      } else {
        fenced_reasons.push('claim_content_json must be a non-null plain object');
      }
    } catch (claimErr: unknown) {
      fenced_reasons.push('claim_content_json is malformed JSON');
    }

    try {
      const p = JSON.parse(sub.canonical_envelope_json);
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
        parsedEnvelope = p as Record<string, unknown>;
      } else {
        fenced_reasons.push('canonical_envelope_json must be a non-null plain object');
      }
    } catch (envErr: unknown) {
      fenced_reasons.push('canonical_envelope_json is malformed JSON');
    }

    // 2. Exact own-property sets
    if (parsedClaim) {
      const claimKeys = Object.keys(parsedClaim).sort();
      const expectedClaimKeys = [...CLAIM_CONTENT_KEYS].sort();
      if (
        claimKeys.length !== expectedClaimKeys.length ||
        claimKeys.some((k, i) => k !== expectedClaimKeys[i])
      ) {
        fenced_reasons.push(
          `claim_content_json own-property set mismatch (keys: ${claimKeys.join(',')})`
        );
      }
    }

    if (parsedEnvelope) {
      const envelopeKeys = Object.keys(parsedEnvelope).sort();
      const expectedEnvelopeKeys = [...CANONICAL_ENVELOPE_KEYS].sort();
      if (
        envelopeKeys.length !== expectedEnvelopeKeys.length ||
        envelopeKeys.some((k, i) => k !== expectedEnvelopeKeys[i])
      ) {
        fenced_reasons.push(
          `canonical_envelope_json own-property set mismatch (keys: ${envelopeKeys.join(',')})`
        );
      }
    }

    // 3. Recompute canonical JSON & SHA-256 directly from stored raw strings
    const recomputedContentHash = computeSha256(sub.claim_content_json);
    const contentMatches = recomputedContentHash === sub.claim_content_hash;
    if (!contentMatches) {
      fenced_reasons.push('Recomputed claim_content_hash mismatch');
    }

    const recomputedEnvelopeHash = computeSha256(sub.canonical_envelope_json);
    const envelopeMatches = recomputedEnvelopeHash === sub.canonical_envelope_hash;
    if (!envelopeMatches) {
      fenced_reasons.push('Recomputed canonical_envelope_hash mismatch');
    }

    // 4. Validate durable authority graph with exact FK/ID equality
    const project = this.repo.getProject(sub.project_id);
    if (!project) {
      fenced_reasons.push(`Project "${sub.project_id}" not found`);
    } else if (project.status !== 'RUNNING') {
      fenced_reasons.push(`Project must be in RUNNING state (got ${project.status})`);
    }

    const task = this.repo.getTask(sub.task_id);
    if (!task) {
      fenced_reasons.push(`Task "${sub.task_id}" not found`);
    } else {
      if (task.project_id !== sub.project_id) {
        fenced_reasons.push(`Task belongs to project "${task.project_id}", expected "${sub.project_id}"`);
      }
      if (typeof task.ownership_epoch !== 'number' || task.ownership_epoch <= 0) {
        fenced_reasons.push(`Task ownership epoch must be positive (got ${task.ownership_epoch})`);
      } else if (task.ownership_epoch !== sub.task_ownership_epoch) {
        fenced_reasons.push(
          `Task ownership epoch mismatch: task (${task.ownership_epoch}) does not match submission (${sub.task_ownership_epoch})`
        );
      }
      if (['DONE', 'FAILED', 'CANCELLED'].includes(task.state)) {
        fenced_reasons.push(`Task cannot be in terminal state (got ${task.state})`);
      }
    }

    const attempt = sub.attempt_id ? this.repo.getTaskAttempt(sub.attempt_id) : null;
    if (!attempt) {
      fenced_reasons.push(`Task attempt "${sub.attempt_id}" not found`);
    } else {
      if (attempt.task_id !== sub.task_id) {
        fenced_reasons.push(`Task attempt belongs to task "${attempt.task_id}", expected "${sub.task_id}"`);
      }
      if (attempt.status !== 'RUNNING') {
        fenced_reasons.push(`Task attempt must be RUNNING (got ${attempt.status})`);
      }
    }

    const assignment = sub.assignment_id ? this.repo.getAgentAssignment(sub.assignment_id) : null;
    if (!assignment) {
      fenced_reasons.push(`Agent assignment "${sub.assignment_id}" not found`);
    } else {
      if (assignment.attempt_id !== sub.attempt_id) {
        fenced_reasons.push(
          `Agent assignment belongs to attempt "${assignment.attempt_id}", expected "${sub.attempt_id}"`
        );
      }
      if (assignment.status !== 'ASSIGNED' && assignment.status !== 'RUNNING') {
        fenced_reasons.push(
          `Agent assignment "${sub.assignment_id}" status must be ASSIGNED or RUNNING (got ${assignment.status})`
        );
      }
    }

    const auth = this.repo.getExecutionAuthorization(sub.authorization_id);
    if (!auth) {
      fenced_reasons.push(`Execution authorization "${sub.authorization_id}" not found`);
    } else {
      if (auth.project_id !== sub.project_id) {
        fenced_reasons.push(`Authorization belongs to project "${auth.project_id}", expected "${sub.project_id}"`);
      }
      if (auth.task_id !== sub.task_id) {
        fenced_reasons.push(`Authorization belongs to task "${auth.task_id}", expected "${sub.task_id}"`);
      }
      if (auth.attempt_id !== sub.attempt_id) {
        fenced_reasons.push(`Authorization belongs to attempt "${auth.attempt_id}", expected "${sub.attempt_id}"`);
      }
      if (auth.assignment_id !== sub.assignment_id) {
        fenced_reasons.push(
          `Authorization belongs to assignment "${auth.assignment_id}", expected "${sub.assignment_id}"`
        );
      }
      if (parsedEnvelope) {
        if (auth.lifecycle_version !== parsedEnvelope.lifecycle_version) {
          fenced_reasons.push(
            `Authorization lifecycle_version (${auth.lifecycle_version}) does not match envelope (${parsedEnvelope.lifecycle_version})`
          );
        }
        if (auth.execution_id !== parsedEnvelope.execution_id) {
          fenced_reasons.push(
            `Authorization execution_id (${auth.execution_id}) does not match envelope (${parsedEnvelope.execution_id})`
          );
        }
        if (auth.routing_decision_id !== parsedEnvelope.routing_decision_id) {
          fenced_reasons.push('Authorization routing_decision_id does not match envelope');
        }
        if (auth.selected_provider_id !== parsedEnvelope.selected_provider_id) {
          fenced_reasons.push('Authorization selected_provider_id does not match envelope');
        }
        if ((auth.selected_account_id ?? null) !== (parsedEnvelope.selected_account_id ?? null)) {
          fenced_reasons.push('Authorization selected_account_id does not match envelope');
        }
        if (auth.selected_resource_id !== parsedEnvelope.selected_resource_id) {
          fenced_reasons.push('Authorization selected_resource_id does not match envelope');
        }
      }

      // Provider row validation
      const provider = this.repo.getProvider(auth.selected_provider_id);
      if (!provider) {
        fenced_reasons.push(`Provider "${auth.selected_provider_id}" not found`);
      } else if (!provider.enabled) {
        fenced_reasons.push('Provider is not enabled');
      }

      // Account row validation
      if (!auth.selected_account_id) {
        fenced_reasons.push('Authorization missing selected_account_id');
      } else {
        const account = this.repo.getProviderAccount(auth.selected_account_id);
        if (!account) {
          fenced_reasons.push(`Provider account "${auth.selected_account_id}" not found`);
        } else {
          if (!account.enabled) {
            fenced_reasons.push('Provider account is not enabled');
          }
          if (account.provider_id !== auth.selected_provider_id) {
            fenced_reasons.push('Provider account provider_id does not match selected_provider_id');
          }
        }
      }

      // Resource row validation
      if (!auth.selected_resource_id) {
        fenced_reasons.push('Authorization missing selected_resource_id');
      } else {
        const resource = this.repo.getProviderResource(auth.selected_resource_id);
        if (!resource) {
          fenced_reasons.push(`Provider resource "${auth.selected_resource_id}" not found`);
        } else {
          if (!resource.enabled) {
            fenced_reasons.push('Provider resource is not enabled');
          }
          if (resource.provider_id !== auth.selected_provider_id) {
            fenced_reasons.push('Provider resource provider_id does not match selected_provider_id');
          }
          if (!resource.provider_account_id) {
            fenced_reasons.push('Provider resource missing provider_account_id');
          } else if (auth.selected_account_id && resource.provider_account_id !== auth.selected_account_id) {
            fenced_reasons.push('Provider resource provider_account_id does not match selected_account_id');
          }
        }
      }

      // Routing decision row validation
      if (!auth.routing_decision_id) {
        fenced_reasons.push('Authorization missing routing_decision_id');
      } else {
        const routingEvent = this.repo.getRoutingDecisionEvent(auth.routing_decision_id);
        if (!routingEvent) {
          fenced_reasons.push(`Routing decision event "${auth.routing_decision_id}" not found`);
        } else {
          const rPayload = routingEvent.structured_payload as Record<string, unknown>;
          if (!rPayload || typeof rPayload !== 'object' || Array.isArray(rPayload)) {
            fenced_reasons.push('Routing decision payload must be a non-null plain object');
          } else {
            // Prohibit snake_case aliases
            const prohibitedAliases = [
              'selected_provider_id',
              'selected_account_id',
              'selected_resource_id',
              'selected_assignment_id',
              'project_id',
              'task_id',
              'attempt_id',
              'decision_id',
            ];
            for (const alias of prohibitedAliases) {
              if (alias in rPayload) {
                fenced_reasons.push(`Routing payload contains non-canonical alias field "${alias}"`);
              }
            }

            if (routingEvent.type === 'ROLE_AWARE_ROUTING_DECISION') {
              const allowedKeys = new Set([
                'decisionId',
                'projectId',
                'taskId',
                'attemptId',
                'roleProfileId',
                'role',
                'outcome',
                'routePolicyId',
                'failoverPolicyAuthoritySnapshot',
                'selectedProviderId',
                'selectedAccountId',
                'selectedResourceId',
                'selectedAssignmentId',
                'requestedConstraints',
                'appliedExclusions',
                'appliedSeparation',
                'reason',
              ]);
              for (const key of Object.keys(rPayload)) {
                if (!allowedKeys.has(key)) {
                  fenced_reasons.push(`Routing payload contains unauthorized additional field "${key}"`);
                }
              }
              if (typeof rPayload.decisionId !== 'string' || rPayload.decisionId !== auth.routing_decision_id) {
                fenced_reasons.push('Routing decision decisionId does not match authorization');
              }
              if (typeof rPayload.projectId !== 'string' || rPayload.projectId !== sub.project_id) {
                fenced_reasons.push('Routing decision projectId does not match submission');
              }
              if (typeof rPayload.taskId !== 'string' || rPayload.taskId !== sub.task_id) {
                fenced_reasons.push('Routing decision taskId does not match submission');
              }
              if (typeof rPayload.attemptId !== 'string' || rPayload.attemptId !== auth.attempt_id) {
                fenced_reasons.push('Routing decision attemptId does not match authorization');
              }
              if (typeof rPayload.selectedProviderId !== 'string' || rPayload.selectedProviderId !== auth.selected_provider_id) {
                fenced_reasons.push('Routing decision selectedProviderId does not match authorization');
              }
              if (typeof rPayload.selectedAccountId !== 'string' || rPayload.selectedAccountId !== auth.selected_account_id) {
                fenced_reasons.push('Routing decision selectedAccountId does not match authorization');
              }
              if (typeof rPayload.selectedResourceId !== 'string' || rPayload.selectedResourceId !== auth.selected_resource_id) {
                fenced_reasons.push('Routing decision selectedResourceId does not match authorization');
              }
              if (assignment && (typeof rPayload.selectedAssignmentId !== 'string' || rPayload.selectedAssignmentId !== assignment.id)) {
                fenced_reasons.push('Routing decision selectedAssignmentId does not match assignment');
              }
              if (rPayload.appliedExclusions !== undefined && !Array.isArray(rPayload.appliedExclusions)) {
                fenced_reasons.push('Routing decision appliedExclusions must be an array');
              }
              if (rPayload.appliedSeparation !== undefined && rPayload.appliedSeparation !== null && (typeof rPayload.appliedSeparation !== 'object' || Array.isArray(rPayload.appliedSeparation))) {
                fenced_reasons.push('Routing decision appliedSeparation must be a plain object or null');
              }
              if (rPayload.requestedConstraints !== undefined && (typeof rPayload.requestedConstraints !== 'object' || rPayload.requestedConstraints === null)) {
                fenced_reasons.push('Routing decision requestedConstraints must be an object or array');
              }
            } else {
              const allowedKeys = new Set([
                'decisionId',
                'projectId',
                'taskId',
                'attemptId',
                'candidateResourceIds',
                'selectedResourceId',
                'selectedProviderId',
                'outcome',
                'reason',
                'candidateEvaluations',
              ]);
              for (const key of Object.keys(rPayload)) {
                if (!allowedKeys.has(key)) {
                  fenced_reasons.push(`Routing payload contains unauthorized additional field "${key}"`);
                }
              }
              if (typeof rPayload.decisionId !== 'string' || rPayload.decisionId !== auth.routing_decision_id) {
                fenced_reasons.push('Routing decision decisionId does not match authorization');
              }
              if (typeof rPayload.projectId !== 'string' || rPayload.projectId !== sub.project_id) {
                fenced_reasons.push('Routing decision projectId does not match submission');
              }
              if (typeof rPayload.taskId !== 'string' || rPayload.taskId !== sub.task_id) {
                fenced_reasons.push('Routing decision taskId does not match submission');
              }
              if (typeof rPayload.attemptId !== 'string' || rPayload.attemptId !== auth.attempt_id) {
                fenced_reasons.push('Routing decision attemptId does not match authorization');
              }
              if (typeof rPayload.selectedProviderId !== 'string' || rPayload.selectedProviderId !== auth.selected_provider_id) {
                fenced_reasons.push('Routing decision selectedProviderId does not match authorization');
              }
              if (typeof rPayload.selectedResourceId !== 'string' || rPayload.selectedResourceId !== auth.selected_resource_id) {
                fenced_reasons.push('Routing decision selectedResourceId does not match authorization');
              }
              if (rPayload.candidateResourceIds !== undefined && !Array.isArray(rPayload.candidateResourceIds)) {
                fenced_reasons.push('Routing decision candidateResourceIds must be an array');
              }
              if (rPayload.candidateEvaluations !== undefined && !Array.isArray(rPayload.candidateEvaluations)) {
                fenced_reasons.push('Routing decision candidateEvaluations must be an array');
              }
            }
          }
        }
      }

      if (!auth.canonical_payload_json) {
        fenced_reasons.push('Execution authorization missing canonical_payload_json');
      } else {
        const payloadValidation = validateAndHashCanonicalExecutionPayload(auth.canonical_payload_json);
        if (!payloadValidation.valid) {
          fenced_reasons.push(`Execution authorization canonical payload invalid: ${payloadValidation.error}`);
        } else if (auth.instruction_payload_hash && payloadValidation.computedHash !== auth.instruction_payload_hash) {
          fenced_reasons.push(
            'Execution authorization canonical payload hash mismatch (INSTRUCTION_PAYLOAD_HASH_MISMATCH)'
          );
        }
      }

      // Worker Slot & Active Account Lease validation if assigned
      const slotId = assignment?.selected_worker_slot_id;
      if (!slotId) {
        fenced_reasons.push('Assignment missing selected_worker_slot_id');
      } else {
        const slot = this.repo.getWorkerSlot(slotId);
        if (!slot) {
          fenced_reasons.push(`Worker slot "${slotId}" not found`);
        } else {
          if (slot.status !== 'LEASED' && slot.status !== 'RUNNING') {
            fenced_reasons.push(`Worker slot status must be LEASED or RUNNING (got ${slot.status})`);
          }
          if (auth.selected_account_id && slot.provider_account_id !== auth.selected_account_id) {
            fenced_reasons.push('Worker slot provider_account_id does not match selected_account_id');
          }
          if (auth.selected_resource_id && slot.provider_resource_id && slot.provider_resource_id !== auth.selected_resource_id) {
            fenced_reasons.push('Worker slot provider_resource_id does not match selected_resource_id');
          }
          const lease = this.repo.getActiveLeaseForSlot(slotId);
          if (!lease) {
            fenced_reasons.push(`Active lease missing for worker slot "${slotId}"`);
          } else {
            if (lease.released_at !== null) {
              fenced_reasons.push('Active lease has non-null released_at');
            }
            if (assignment && lease.assignment_id !== assignment.id) {
              fenced_reasons.push('Active lease assignment_id does not match assignment');
            }
            if (auth.selected_account_id && lease.provider_account_id !== auth.selected_account_id) {
              fenced_reasons.push('Active lease provider_account_id does not match selected_account_id');
            }
            if (!lease.lease_token || typeof lease.lease_token !== 'string') {
              fenced_reasons.push('Active lease missing lease_token');
            }
          }
        }
      }

      // Manager protocol row selected by exact durable record ID, never latest-row fallback
      const managerMsgId = auth.manager_message_id;
      if (!managerMsgId) {
        fenced_reasons.push('Authorization missing manager_message_id');
      } else {
        const msgRow = this.db
          .prepare('SELECT * FROM protocol_messages WHERE id = ?')
          .get(managerMsgId) as Record<string, unknown> | undefined;
        if (!msgRow) {
          fenced_reasons.push(`Manager protocol message "${managerMsgId}" not found by exact record ID`);
        } else {
          if (typeof msgRow.raw_payload !== 'string') {
            fenced_reasons.push('Manager protocol message raw_payload missing or not a string');
          } else {
            const rawMsgPayload = msgRow.raw_payload;
            const recomputedMsgHash = computeSha256(rawMsgPayload);
            if (recomputedMsgHash !== auth.manager_payload_hash) {
              fenced_reasons.push('Manager protocol message raw payload hash mismatch');
            }
            if (msgRow.payload_hash !== auth.manager_payload_hash) {
              fenced_reasons.push('Manager protocol message stored payload_hash mismatch');
            }
            try {
              const parsedPayload = JSON.parse(rawMsgPayload);
              if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) {
                fenced_reasons.push('Manager protocol message raw_payload must be a non-null plain object');
              } else {
                const baseManagerKeys = [
                  'acceptance_criteria',
                  'constraints',
                  'created_at',
                  'decision',
                  'expected_revision',
                  'expected_task_state',
                  'instructions',
                  'message_id',
                  'priority',
                  'project_id',
                  'protocol',
                  'review_issues',
                  'risk',
                  'task_id',
                ].sort();
                const actualKeys = Object.keys(parsedPayload).sort();
                const hasRouting = actualKeys.includes('routing');
                const expectedKeys = hasRouting ? [...baseManagerKeys, 'routing'].sort() : baseManagerKeys;

                if (
                  actualKeys.length !== expectedKeys.length ||
                  actualKeys.some((k, i) => k !== expectedKeys[i])
                ) {
                  fenced_reasons.push('Manager protocol message payload key mismatch (missing or extra keys)');
                }
                if (hasRouting) {
                  const routingVal = parsedPayload.routing;
                  if (typeof routingVal !== 'object' || routingVal === null || Array.isArray(routingVal)) {
                    fenced_reasons.push('Manager protocol message nested routing must be a non-null plain object');
                  } else {
                    const routingKeys = Object.keys(routingVal).sort();
                    const expectedRoutingKeys = ['account_id', 'provider_id', 'resource_id', 'routing_decision_id'].sort();
                    if (
                      routingKeys.length !== expectedRoutingKeys.length ||
                      routingKeys.some((k, i) => k !== expectedRoutingKeys[i])
                    ) {
                      fenced_reasons.push('Manager protocol message nested routing keys mismatch');
                    } else {
                      const rObj = routingVal as Record<string, unknown>;
                      if (rObj.routing_decision_id !== auth.routing_decision_id) {
                        fenced_reasons.push('Manager protocol nested routing_decision_id mismatch');
                      }
                      if (rObj.provider_id !== auth.selected_provider_id) {
                        fenced_reasons.push('Manager protocol nested provider_id mismatch');
                      }
                      if (auth.selected_account_id && rObj.account_id !== auth.selected_account_id) {
                        fenced_reasons.push('Manager protocol nested account_id mismatch');
                      }
                      if (rObj.resource_id !== auth.selected_resource_id) {
                        fenced_reasons.push('Manager protocol nested resource_id mismatch');
                      }
                    }
                  }
                }
                if (parsedPayload.protocol !== 'manager.v1') {
                  fenced_reasons.push(`Manager protocol message protocol must be manager.v1 (got ${parsedPayload.protocol})`);
                }
                if (parsedPayload.project_id !== sub.project_id) {
                  fenced_reasons.push('Manager protocol message project_id mismatch');
                }
                if (typeof parsedPayload.task_id !== 'string' || !parsedPayload.task_id.trim()) {
                  fenced_reasons.push('Manager protocol message task_id must be non-empty string');
                } else if (parsedPayload.task_id !== sub.task_id) {
                  fenced_reasons.push('Manager protocol message task_id mismatch');
                }
                if (!['CREATE_TASKS', 'EXECUTE', 'PASS', 'FIX_REQUIRED', 'BLOCK', 'PAUSE', 'CANCEL', 'NEEDS_OWNER'].includes(parsedPayload.decision as string)) {
                  fenced_reasons.push(`Manager protocol message decision invalid: ${parsedPayload.decision}`);
                }
                if (!Array.isArray(parsedPayload.instructions)) {
                  fenced_reasons.push('Manager protocol message instructions must be an array');
                }
                if (!Array.isArray(parsedPayload.acceptance_criteria)) {
                  fenced_reasons.push('Manager protocol message acceptance_criteria must be an array');
                }
                if (!Array.isArray(parsedPayload.constraints)) {
                  fenced_reasons.push('Manager protocol message constraints must be an array');
                }
                if (!Array.isArray(parsedPayload.review_issues)) {
                  fenced_reasons.push('Manager protocol message review_issues must be an array');
                }
              }
            } catch (msgErr: unknown) {
              fenced_reasons.push('Manager protocol message raw_payload is malformed JSON');
            }
          }
        }
      }
    }

    if (contentMatches && envelopeMatches && fenced_reasons.length === 0 && parsedClaim && parsedEnvelope) {
      return {
        valid: true,
        claim_content_hash_matches: true,
        canonical_envelope_hash_matches: true,
        parsed_claim: parsedClaim,
        parsed_envelope: parsedEnvelope,
        fenced_reasons: [],
      };
    }

    return {
      valid: false,
      claim_content_hash_matches: contentMatches,
      canonical_envelope_hash_matches: envelopeMatches,
      parsed_claim: parsedClaim,
      parsed_envelope: parsedEnvelope,
      fenced_reasons,
    };
  }

  /**
   * Helper to validate stored hashes and graph of a CoderSubmission.
   */
  public validateSubmissionIntegrity(sub: CoderSubmission): {
    valid: boolean;
    claim_content_hash_matches: boolean;
    canonical_envelope_hash_matches: boolean;
    fenced_reasons: string[];
    fenced_reason: string | null;
  } {
    const result = this.validateSubmissionAndAuthorityIntegrity(sub);
    return {
      valid: result.valid,
      claim_content_hash_matches: result.claim_content_hash_matches,
      canonical_envelope_hash_matches: result.canonical_envelope_hash_matches,
      fenced_reasons: result.fenced_reasons,
      fenced_reason: result.fenced_reasons.length > 0 ? result.fenced_reasons.join('; ') : null,
    };
  }

  /**
   * Builds the complete, exact canonical authority snapshot.
   */
  public buildCanonicalAuthoritySnapshot(sub: CoderSubmission): CanonicalAuthoritySnapshot {
    const project = this.repo.getProject(sub.project_id)!;
    const task = this.repo.getTask(sub.task_id)!;
    const auth = this.repo.getExecutionAuthorization(sub.authorization_id)!;
    const attempt = sub.attempt_id ? this.repo.getTaskAttempt(sub.attempt_id) : null;
    const assignment = sub.assignment_id ? this.repo.getAgentAssignment(sub.assignment_id) : null;
    if (!attempt || !assignment) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        'Attempt or assignment missing from submission'
      );
    }

    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');

    // Reject null/undefined/empty where lifecycle phase requires binding:
    if (!auth.lifecycle_version || typeof auth.lifecycle_version !== 'number') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing lifecycle_version');
    }
    if (!auth.execution_id || typeof auth.execution_id !== 'string') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing execution_id');
    }
    if (!auth.manager_message_id || typeof auth.manager_message_id !== 'string') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing manager_message_id');
    }
    if (!auth.canonical_payload_json || typeof auth.canonical_payload_json !== 'string') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing canonical_payload_json');
    }
    const payloadValidation = validateAndHashCanonicalExecutionPayload(auth.canonical_payload_json);
    if (!payloadValidation.valid) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        `Execution authorization canonical payload invalid: ${payloadValidation.error}`
      );
    }

    const snapshot: CanonicalAuthoritySnapshot = {
      assignment_id: assignment.id,
      assignment_status: assignment.status,
      attempt_id: attempt.id,
      attempt_number: attempt.attempt_number,
      attempt_status: attempt.status,
      authorization_canonical_payload_hash: payloadValidation.computedHash,
      authorization_id: auth.id,
      authorization_lifecycle_version: auth.lifecycle_version,
      authorization_status: auth.status,
      authorized_repository_head_sha: auth.repository_head_sha,
      canonical_envelope_hash: sub.canonical_envelope_hash,
      claim_content_hash: sub.claim_content_hash,
      current_terminal_disposition: terminalDisp ? `${terminalDisp.disposition_event}/${terminalDisp.disposition_reason}` : null,
      execution_id: auth.execution_id,
      manager_protocol_message_id: auth.manager_message_id,
      manager_raw_payload_hash: auth.manager_payload_hash,
      project_id: project.id,
      project_repository_path: project.repository_path,
      project_status: project.status,
      quarantine_status: 'QUARANTINED',
      routing_decision_id: auth.routing_decision_id,
      selected_account_id: auth.selected_account_id ?? null,
      selected_provider_id: auth.selected_provider_id,
      selected_resource_id: auth.selected_resource_id,
      submission_base_sha: sub.base_sha,
      submission_id: sub.id,
      submission_repository_head_sha: sub.authorized_head_sha,
      submitted_at: sub.submitted_at,
      task_base_sha: task.base_sha || '',
      task_id: task.id,
      task_ownership_epoch: sub.task_ownership_epoch,
      task_state: task.state,
      worker_slot_id: assignment.selected_worker_slot_id ?? ((auth as unknown as Record<string, unknown>).worker_slot_id as string | null | undefined) ?? null,
    };

    // Assert exact top-level property keys
    const keys = Object.keys(snapshot).sort();
    const expectedKeys = [...AUTHORITY_SNAPSHOT_KEYS].sort();
    if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
      throw new CoderSubmissionAdjudicationError('INTEGRITY_CONFLICT', 'Authority snapshot key set mismatch');
    }

    return snapshot;
  }

  /**
   * Captures a canonical workspace fingerprint that binds HEAD, porcelain status,
   * tracked diff, and untracked file contents deterministically.
   */
  public async captureCanonicalWorkspaceFingerprint(
    repoPath: string,
    baseSha?: string
  ): Promise<CanonicalWorkspaceFingerprint> {
    const headRes = await GitService.getHeadSha(repoPath);
    if (headRes.status !== 'SUCCESS' || !headRes.sha) {
      throw new CoderSubmissionAdjudicationError('WORKTREE_DRIFT', 'Failed to read repository HEAD SHA');
    }

    const statusProc = await ProcessRunner.execute({
      executable: 'git',
      args: ['status', '--porcelain=v1', '-uall'],
      cwd: repoPath,
      timeoutMs: 15000,
    });

    if (statusProc.exitCode !== 0) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Git status failed with exit code ${statusProc.exitCode}: ${statusProc.stderr}`
      );
    }

    const statusLines = statusProc.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .sort();
    const statusHash = computeSha256(statusLines.join('\n'));

    // Tracked diff identity
    const diffProc = await ProcessRunner.execute({
      executable: 'git',
      args: ['diff', 'HEAD'],
      cwd: repoPath,
      timeoutMs: 20000,
    });
    const diffHash = computeSha256(diffProc.exitCode === 0 ? diffProc.stdout : '');

    // Deterministic content identity for untracked files
    const untrackedFileLines: string[] = [];
    for (const line of statusLines) {
      if (line.startsWith('?? ')) {
        const relPath = line.substring(3).trim();
        const absPath = path.join(repoPath, relPath);
        let contentHash = 'MISSING';
        try {
          if (fs.existsSync(absPath)) {
            const buf = fs.readFileSync(absPath);
            contentHash = crypto.createHash('sha256').update(buf).digest('hex');
          }
        } catch (readErr: unknown) {
          contentHash = 'UNREADABLE';
        }
        untrackedFileLines.push(`${relPath}:${contentHash}`);
      }
    }
    untrackedFileLines.sort();
    const untrackedFilesHash = computeSha256(untrackedFileLines.join('\n'));

    const fingerprintPayload = canonicalJsonStringify({
      diff_hash: diffHash,
      head_sha: headRes.sha,
      status_hash: statusHash,
      status_lines: statusLines,
      untracked_files_hash: untrackedFilesHash,
    });

    const branchRes = await GitService.getCurrentBranch(repoPath);
    const branch = branchRes.status === 'SUCCESS' ? branchRes.branch ?? null : null;

    return {
      head_sha: headRes.sha,
      status_lines: statusLines,
      status_hash: statusHash,
      diff_hash: diffHash,
      untracked_files_hash: untrackedFilesHash,
      fingerprint_hash: computeSha256(fingerprintPayload),
      isClean: statusLines.length === 0,
      branch,
    };
  }
}
