import { describe, expect, it } from 'vitest';
import { OUTPUT_MAX_STRUCTURE_DEPTH, OUTPUT_MAX_STRUCTURE_NODES, OUTPUT_MAX_TEXT_CHARACTERS,
  OutputSanitizationError, redactSensitiveText, REDACTED_SECRET, sanitizeOutputValue } from '../src/shared/security/secretRedaction';

// Every credential-shaped value is synthetic. Failures report labels/booleans
// rather than original values; the protected test runner remains mandatory.
const opaque = 'AF_TEST_ONLY_VALUE';
const fixtures = [
  ['openai', 'sk-proj-' + 'AF_TEST_ONLY_'.repeat(4)],
  ['google', 'AIza' + 'AF_TEST_ONLY_'.repeat(4)],
  ['npm', 'npm_' + 'AFTESTONLY'.repeat(4)],
  ['github', 'ghp_' + 'AF_TEST_ONLY_'.repeat(4)],
  ['github-pat', 'github_pat_' + 'AF_TEST_ONLY_'.repeat(4)],
  ['aws', 'AKIAAFTESTONLY012345'],
  ['aws-session', 'ASIAAFTESTONLY012345'],
  ['google-oauth', 'ya29.' + 'AF_TEST_ONLY_'.repeat(3)],
  ['slack', 'xoxb-' + 'AF-TEST-ONLY-'.repeat(3)],
  ['api-key', 'api_key=' + opaque],
  ['password', 'password: "' + opaque + '"'],
  ['multiline', 'private_key="' + opaque + '\nsecond-line-fixture"'],
  ['incomplete-multiline', 'password="first-fixture-line\n' + opaque],
  ['incomplete-escape', 'password="first-fixture-line\n' + opaque + '\\'],
  ['url', 'https://fixture-user:' + opaque + '@example.invalid/path'],
  ['url-encoded', 'https://fixture-user%3A' + opaque + '@example.invalid/path'],
  ['url-userinfo-at', 'https://fixture-user:fixture-part@' + opaque + '@example.invalid/path'],
  ['bearer', 'Bearer ' + opaque],
  ['jwt', 'eyJhbGciOiJub25lIn0.eyJmaXh0dXJlIjp0cnVlfQ.AF_TEST_ONLY_SIGNATURE'],
  ['pem', '-----BEGIN PRIVATE KEY-----\n' + opaque + '\n-----END PRIVATE KEY-----'],
  ['incomplete-pem', '-----BEGIN OPENSSH PRIVATE KEY-----\n' + opaque],
  ['json-key', JSON.stringify({ apiKey: opaque })],
  ['escaped-json', JSON.stringify(JSON.stringify({ password: opaque }))],
  ['unicode-key', String.raw`{"api_\u006bey":"AF_TEST_ONLY_VALUE"}`],
  ['percent-key', '%61%70%69%5f%6b%65%79%3D' + opaque],
  ['npm-config', '//registry.npmjs.org/:_authToken=' + opaque],
  ['cloud-key', 'AccountKey=' + opaque],
  ['provider-environment', 'OPENAI_API_KEY=' + opaque],
  ['cloud-environment', 'AWS_SESSION_TOKEN=' + opaque],
] as const;

describe('bounded shared output sanitizer', () => {
  it.each(fixtures)('redacts %s text deterministically and idempotently', (_label, text) => {
    const safe = redactSensitiveText('fixture diagnostic: ' + text);
    expect(safe.includes(text)).toBe(false);
    expect(safe.includes(opaque)).toBe(false);
    expect(safe.includes(REDACTED_SECRET)).toBe(true);
    expect(redactSensitiveText(safe) === safe).toBe(true);
    expect(redactSensitiveText('fixture diagnostic: ' + text) === safe).toBe(true);
  });

  it('preserves ordinary diagnostics, hashes, identifiers and harmless escaped text', () => {
    const text = 'FAILED EACCES C:\\Code\\Demo\\private_key.pem; token_count=3; api_key_hash=' + 'a'.repeat(64) + '\\nnext fixture line';
    expect(redactSensitiveText(text)).toBe(text);
    const value = { status: 'FAILED', exit_code: 9, authorization_id: 'auth-fixture', hash: 'b'.repeat(64), nested: [null, true, 7, text] };
    expect(sanitizeOutputValue(value)).toEqual(value);
  });

  it('preserves complete replacement markers at real assignment boundaries', () => {
    for (const text of [
      'password=' + REDACTED_SECRET,
      'password=' + REDACTED_SECRET + ' \t; ordinary diagnostic',
      'password=' + REDACTED_SECRET + '\nordinary diagnostic',
      JSON.stringify({ password: REDACTED_SECRET, apiKey: REDACTED_SECRET }),
      JSON.stringify({ stdout: 'password=' + REDACTED_SECRET + '\n', stderr: JSON.stringify({ api_key: REDACTED_SECRET }) }),
      JSON.stringify(JSON.stringify({ stderr: 'password=' + REDACTED_SECRET + '\n' })),
    ]) expect(redactSensitiveText(text)).toBe(text);
  });

  it.each([
    'password=[' + opaque + ',"second-fixture"]',
    'password=' + REDACTED_SECRET + ' ' + opaque,
    '%70%61%73%73%77%6f%72%64%3d%5bREDACTED_SECRET%5d' + opaque,
  ])('rejects unbounded credential members or an incomplete marker %# with a fixed error', text => {
    expect(() => redactSensitiveText(text)).toThrow('OUTPUT_REDACTION_UNSAFE: Durable output could not be sanitized safely.');
  });

  it('redacts sensitive structured keys including encoded/camel-case names without mutating input', () => {
    const input = { apiKey: opaque, OPENAI_API_KEY: opaque, nested: [{ 'private-key': opaque }, { 'api\\u005fkey': opaque }], password: null, empty: '' };
    const safe = sanitizeOutputValue(input);
    expect(JSON.stringify(safe).includes(opaque)).toBe(false);
    expect(input.apiKey === opaque).toBe(true);
    expect(JSON.stringify(sanitizeOutputValue(safe)) === JSON.stringify(safe)).toBe(true);
  });

  it.each([undefined, NaN, Infinity, 1n, new Date(0), () => 1, Symbol('fixture')])('rejects unsafe root type %# with a fixed error', input => {
    let code: unknown; let message = '';
    try { sanitizeOutputValue(input); } catch (error) { code = (error as OutputSanitizationError).code; message = (error as Error).message; }
    expect(code).toBe('OUTPUT_TYPE_INVALID');
    expect(message.includes(opaque)).toBe(false);
  });

  it('rejects cycles and getters without calling a getter or exposing foreign errors', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => sanitizeOutputValue(cyclic)).toThrow(OutputSanitizationError);
    let called = false;
    const getter = Object.defineProperty({}, 'notes', { enumerable: true, get() { called = true; throw new Error(opaque); } });
    expect(() => sanitizeOutputValue(getter)).toThrow(OutputSanitizationError);
    expect(called).toBe(false);
    const proxy = new Proxy({}, { ownKeys() { throw new Error(opaque); } });
    let code: unknown; let message = '';
    try { sanitizeOutputValue(proxy); } catch (error) { code = (error as OutputSanitizationError).code; message = (error as Error).message; }
    expect(code).toBe('OUTPUT_TYPE_INVALID'); expect(message.includes(opaque)).toBe(false);
    const forged = new OutputSanitizationError('OUTPUT_SIZE_EXCEEDED');
    forged.message = opaque;
    const forgedProxy = new Proxy({}, { ownKeys() { throw forged; } });
    try { sanitizeOutputValue(forgedProxy); } catch (error) { message = (error as Error).message; }
    expect(message).toBe('OUTPUT_SIZE_EXCEEDED: Durable output could not be sanitized safely.');
  });

  it('enforces text, cumulative text, structure depth and node ceilings before serialization', () => {
    expect(() => redactSensitiveText('x'.repeat(OUTPUT_MAX_TEXT_CHARACTERS + 1))).toThrow('OUTPUT_SIZE_EXCEEDED');
    const half = 'x'.repeat(OUTPUT_MAX_TEXT_CHARACTERS / 2);
    expect(() => sanitizeOutputValue({ first: half, second: half })).toThrow('OUTPUT_SIZE_EXCEEDED');
    expect(() => sanitizeOutputValue(new Array(OUTPUT_MAX_STRUCTURE_NODES + 1).fill(null))).toThrow('OUTPUT_SIZE_EXCEEDED');
    let deep: unknown = null;
    for (let index = 0; index <= OUTPUT_MAX_STRUCTURE_DEPTH; index += 1) deep = { child: deep };
    expect(() => sanitizeOutputValue(deep)).toThrow('OUTPUT_SIZE_EXCEEDED');
  });

  it('keeps JSON omission semantics, rejects sparse arrays and safely clones prototype-shaped keys', () => {
    expect(sanitizeOutputValue({ optional: undefined, valid: 1 })).toEqual({ valid: 1 });
    expect(() => sanitizeOutputValue(new Array(1))).toThrow('OUTPUT_TYPE_INVALID');
    const input = JSON.parse('{"__proto__":{"safe":1},"constructor":"fixture"}');
    const safe = sanitizeOutputValue(input) as object;
    expect(Object.getPrototypeOf(safe)).toBeNull();
    expect(JSON.stringify(safe)).toBe(JSON.stringify(input));
  });
});
