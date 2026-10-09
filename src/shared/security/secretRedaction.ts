/** Fixed replacement for credential-bearing durable output. */
export const REDACTED_SECRET = '[REDACTED_SECRET]';

/** Work ceilings apply before decoding, regular expressions or serialization. */
export const OUTPUT_MAX_TEXT_CHARACTERS = 32 * 1024 * 1024;
export const OUTPUT_MAX_STRUCTURE_NODES = 50_000;
export const OUTPUT_MAX_STRUCTURE_DEPTH = 32;

export type OutputSanitizationErrorCode = 'OUTPUT_TYPE_INVALID' | 'OUTPUT_SIZE_EXCEEDED' | 'OUTPUT_REDACTION_UNSAFE';

export class OutputSanitizationError extends Error {
  constructor(public readonly code: OutputSanitizationErrorCode) {
    super(`${code}: Durable output could not be sanitized safely.`);
    this.name = 'OutputSanitizationError';
  }
}

const sensitiveKeys = new Set([
  'apikey', 'password', 'passwd', 'pwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'clientsecret', 'oauthtoken', 'secrettoken', 'plaintexttoken', 'privatekey',
  'secretaccesskey', 'awssecretaccesskey', 'authorization', 'proxyauthorization', 'cookie', 'setcookie',
  'connectionstring',
  'authtoken', 'sessiontoken', 'auth', 'accountkey', 'secretkey', 'signingkey',
]);
const keyName = '(?:api[_ -]?key|password|passwd|pwd|secret|token|access[_ -]?token|refresh[_ -]?token|' +
  'id[_ -]?token|client[_ -]?secret|oauth[_ -]?token|secret[_ -]?token|plaintext[_ -]?token|' +
  '(?:aws[_ -]?)?secret[_ -]?access[_ -]?key|private[_ -]?key|(?:proxy[_ -]?)?authorization|(?:set[_ -]?)?cookie|connection[_ -]?string|' +
  '_?auth(?:[_ -]?token)?|session[_ -]?token|account[_ -]?key|secret[_ -]?key|signing[_ -]?key)';
// Include bounded environment/config namespaces (for example OPENAI_API_KEY),
// while leaving *_id, *_hash and token_count metadata unchanged.
const credentialName = '(?:[a-z][a-z0-9]{0,31}[_-]){0,4}' + keyName;
const credentialKey = new RegExp('^' + credentialName + '$', 'i');
const assignmentPrefix = '(\\b' + credentialName + '\\b["\']?\\s*[:=]\\s*)';
// A diagnostic may be embedded in JSON text. Accept quotes/newlines escaped
// through at most four JSON layers, still requiring a complete value boundary.
const markerEnd = String.raw`(?=[ \t]*(?:$|[\r\n,;}\]"']|\\{1,15}[nr"']))`;
// Text has no trustworthy structure for a compound credential value. Reject
// it rather than replacing only its first member, or trusting a marker prefix.
const unsafeCompoundAssignment = new RegExp(assignmentPrefix +
  String.raw`(?:\{|\[(?!REDACTED_SECRET\]` + markerEnd + '))', 'i');
const assignment = new RegExp(assignmentPrefix +
  String.raw`(\[REDACTED_SECRET\]` + markerEnd + String.raw`|"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$)|[^\r\n,;}\]]+)`, 'gi');
const patterns = [
  /\bsk-(?:[A-Za-z0-9_-]{10,})/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\b(?:npm_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bya29\.[A-Za-z0-9_-]{10,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\baf-sub-[A-Za-z0-9_-]{43}/gi,
  /\baf-rev-[0-9a-f-]{36}/gi,
  /\bBearer\s+[^\s,;"'<>]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z0-9 ][A-Z0-9 -]{0,63}-----[\s\S]*?(?:-----END [A-Z0-9 ][A-Z0-9 -]{0,63}-----|$)/g,
];

function redactPlainText(text: string, omitAssignmentLabels = false): string {
  if (unsafeCompoundAssignment.test(text)) throw new OutputSanitizationError('OUTPUT_REDACTION_UNSAFE');
  let result = text;
  for (const pattern of patterns) result = result.replace(pattern, REDACTED_SECRET);
  // Userinfo can contain a token without a literal ':' (including percent
  // encoding). Keep the scheme/host/path but never retain the userinfo.
  result = result.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, `$1${REDACTED_SECRET}@`);
  result = result.replace(assignment, (_match, prefix: string, value: string) => {
    if (omitAssignmentLabels && value !== '""' && value !== "''") return REDACTED_SECRET;
    if (value === REDACTED_SECRET || value === '""' || value === "''") return prefix + value;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return prefix + quote + REDACTED_SECRET + quote;
  });
  return result;
}

function decodeEscapeLayer(text: string): string {
  return text.replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|(["'\\/nrt]))|%([0-9a-f]{2})/gi,
    (_match, unicode: string | undefined, hex: string | undefined, escaped: string | undefined, percent: string | undefined) => {
      if (unicode || hex || percent) return String.fromCharCode(parseInt(unicode ?? hex ?? percent!, 16));
      return escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped!;
    });
}

/** Sanitizes the complete bounded value; callers may truncate only afterwards. */
export function redactSensitiveText(value: unknown, options?: { assignmentLabels: 'omit' }): string {
  if (typeof value !== 'string') throw new OutputSanitizationError('OUTPUT_TYPE_INVALID');
  if (value.length > OUTPUT_MAX_TEXT_CHARACTERS) throw new OutputSanitizationError('OUTPUT_SIZE_EXCEEDED');
  const redacted = redactPlainText(value, options?.assignmentLabels === 'omit');
  if (redacted.length > OUTPUT_MAX_TEXT_CHARACTERS) throw new OutputSanitizationError('OUTPUT_SIZE_EXCEEDED');
  // Do not rewrite harmless escaped diagnostics. If an encoded view reveals
  // an additional secret, discard the whole text rather than guess offsets
  // into its original representation. Limit nested escape work explicitly.
  let decoded = redacted;
  for (let layer = 0; layer < 4; layer += 1) {
    const next = decodeEscapeLayer(decoded);
    if (next === decoded) return redacted;
    if (redactPlainText(next) !== next) return REDACTED_SECRET;
    decoded = next;
  }
  if (decodeEscapeLayer(decoded) !== decoded) throw new OutputSanitizationError('OUTPUT_REDACTION_UNSAFE');
  return redacted;
}

/**
 * Clone JSON-shaped output without invoking getters/toJSON. Object undefined
 * properties are omitted like JSON serialization; unsafe array/root values,
 * prototypes, cycles, depth/size/node overflows and key collisions are rejected.
 * No original value or caught diagnostic is included in a failure.
 */
export function sanitizeOutputValue(value: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  let characters = 0;
  function account(text: string): void {
    characters += text.length;
    if (characters > OUTPUT_MAX_TEXT_CHARACTERS) throw new OutputSanitizationError('OUTPUT_SIZE_EXCEEDED');
  }
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > OUTPUT_MAX_STRUCTURE_NODES || depth > OUTPUT_MAX_STRUCTURE_DEPTH) throw new OutputSanitizationError('OUTPUT_SIZE_EXCEEDED');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') { account(input); return redactSensitiveText(input); }
    if (!input || typeof input !== 'object' || active.has(input)) throw new OutputSanitizationError('OUTPUT_TYPE_INVALID');
    const prototype = Object.getPrototypeOf(input);
    if ((!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(input).length) {
      throw new OutputSanitizationError('OUTPUT_TYPE_INVALID');
    }
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > OUTPUT_MAX_STRUCTURE_NODES) throw new OutputSanitizationError('OUTPUT_SIZE_EXCEEDED');
        const result: unknown[] = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor)) throw new OutputSanitizationError('OUTPUT_TYPE_INVALID');
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const keys = Object.keys(input);
      if (keys.length > OUTPUT_MAX_STRUCTURE_NODES) throw new OutputSanitizationError('OUTPUT_SIZE_EXCEEDED');
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) throw new OutputSanitizationError('OUTPUT_TYPE_INVALID');
        if (descriptor.value === undefined) continue;
        account(key);
        const safeKey = redactSensitiveText(key);
        if (Object.prototype.hasOwnProperty.call(result, safeKey)) throw new OutputSanitizationError('OUTPUT_TYPE_INVALID');
        let decodedKey = key;
        for (let layer = 0; layer < 4; layer += 1) decodedKey = decodeEscapeLayer(decodedKey);
        if (decodeEscapeLayer(decodedKey) !== decodedKey) throw new OutputSanitizationError('OUTPUT_REDACTION_UNSAFE');
        const sensitive = sensitiveKeys.has(decodedKey.replace(/[^a-z0-9]/gi, '').toLowerCase()) || credentialKey.test(decodedKey);
        // Visit even a fully redacted credential field to enforce shape/work
        // bounds; a secret key must not hide a cyclic or unbounded value.
        const safeValue = visit(descriptor.value, depth + 1);
        // Credential nulls use the same fixed marker as the text policy, so a
        // sanitized JSON value stays unchanged at a later text/artifact sink.
        result[safeKey] = sensitive && safeValue !== '' ? REDACTED_SECRET : safeValue;
      }
      return result;
    } finally { active.delete(input); }
  }
  try { return visit(value, 0); }
  catch (error) {
    // A hostile Proxy can throw an instance of our exported error with an
    // altered message/code. Reconstruct only an admitted code, never its text.
    let code: OutputSanitizationErrorCode = 'OUTPUT_TYPE_INVALID';
    try {
      const candidate = error instanceof OutputSanitizationError ? error.code : undefined;
      if (candidate === 'OUTPUT_TYPE_INVALID' || candidate === 'OUTPUT_SIZE_EXCEEDED' || candidate === 'OUTPUT_REDACTION_UNSAFE') code = candidate;
    } catch { /* foreign errors and accessors have no diagnostic authority */ }
    throw new OutputSanitizationError(code);
  }
}
