import { describe, expect, it } from 'vitest';
import {
  CANONICAL_EXECUTION_PAYLOAD_EXACT_KEYS,
  validateAndHashCanonicalExecutionPayload,
} from '../src/core/services/adjudication/canonicalExecutionPayload';
import { validateAndHashCanonicalExecutionPayload as validateViaServiceFacade } from '../src/core/services/CoderSubmissionAdjudicationService';
import { computePayloadHash } from '../src/core/services/ExecutionAuthorizationService';
import type { CanonicalExecutionPayload } from '../src/core/services/ExecutionAuthorizationService';

function validPayload(): CanonicalExecutionPayload {
  return {
    acceptanceCriteria: ['all checks pass'],
    attemptId: 'attempt-1',
    constraints: ['preserve authority'],
    contextFiles: ['README.md'],
    instructions: ['run the focused tests'],
    managerMessageId: 'manager-message-1',
    managerPayloadHash: 'a'.repeat(64),
    projectId: 'project-1',
    taskDescription: 'Validate canonical payload handling',
    taskId: 'task-1',
    taskTitle: 'Canonical payload test',
    verificationCommands: {
      TEST: {
        executable: 'npm.cmd',
        args: ['test'],
        timeout_ms: 120000,
      },
      LINT: null,
      BUILD: null,
    },
  } as CanonicalExecutionPayload;
}

describe('canonical execution payload extraction contract', () => {
  it('keeps the exact key set and computes the canonical payload hash', () => {
    const payload = validPayload();
    const result = validateAndHashCanonicalExecutionPayload(JSON.stringify(payload));

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed).toEqual(payload);
    expect(result.computedHash).toBe(computePayloadHash(payload));
    expect(validateViaServiceFacade(JSON.stringify(payload))).toEqual(result);
    expect([...CANONICAL_EXECUTION_PAYLOAD_EXACT_KEYS].sort()).toEqual([
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
    ].sort());
  });

  it.each([
    ['', 'Empty or missing canonical_payload_json'],
    ['{', 'Malformed JSON in canonical_payload_json'],
    ['[]', 'canonical_payload_json must be a strict plain object'],
    ['null', 'canonical_payload_json must be a strict plain object'],
  ])('rejects malformed input %j with a deterministic error', (rawJson, error) => {
    const result = validateAndHashCanonicalExecutionPayload(rawJson);
    expect(result).toEqual({ valid: false, computedHash: '', parsed: null, error });
  });

  it('rejects missing and extra fields before hashing', () => {
    const missing = validPayload() as unknown as Record<string, unknown>;
    delete missing.taskId;
    const missingResult = validateAndHashCanonicalExecutionPayload(JSON.stringify(missing));
    expect(missingResult.valid).toBe(false);
    expect(missingResult.error).toBe('canonical_payload_json has invalid property set (missing or extra keys)');

    const extra = { ...validPayload(), unexpected: true };
    const extraResult = validateAndHashCanonicalExecutionPayload(JSON.stringify(extra));
    expect(extraResult.valid).toBe(false);
    expect(extraResult.error).toBe('canonical_payload_json has invalid property set (missing or extra keys)');
  });

  it.each([
    ['projectId', { projectId: '' }, 'projectId must be non-empty string'],
    ['attemptId', { attemptId: 0 }, 'attemptId must be string or null'],
    ['acceptanceCriteria', { acceptanceCriteria: ['ok', 1] }, 'acceptanceCriteria must be string array'],
    ['managerPayloadHash', { managerPayloadHash: 'not-a-hash' }, 'managerPayloadHash must be 64-char hex'],
    ['verificationCommands', { verificationCommands: [] }, 'verificationCommands must be non-null object'],
    ['timeout_ms', { verificationCommands: { TEST: { executable: 'npm', args: [], timeout_ms: 0 } } }, 'verificationCommands.TEST timeout_ms must be a positive integer <= 600000'],
  ])('rejects invalid %s values without returning a hash', (_field, override, error) => {
    const result = validateAndHashCanonicalExecutionPayload(
      JSON.stringify({ ...validPayload(), ...override })
    );
    expect(result.valid).toBe(false);
    expect(result.computedHash).toBe('');
    expect(result.parsed).toBeNull();
    expect(result.error).toBe(error);
  });

  it('accepts null optional fields and uppercase manager hashes without changing hash semantics', () => {
    const payload = { ...validPayload(), attemptId: null, taskDescription: null, managerPayloadHash: 'B'.repeat(64) };
    const result = validateAndHashCanonicalExecutionPayload(JSON.stringify(payload));

    expect(result.valid).toBe(true);
    expect(result.computedHash).toBe(computePayloadHash(payload));
  });
});
