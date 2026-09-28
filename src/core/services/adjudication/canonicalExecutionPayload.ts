import { computePayloadHash, CanonicalExecutionPayload } from '../ExecutionAuthorizationService';

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
