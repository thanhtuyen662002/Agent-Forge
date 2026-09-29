import { z } from 'zod';

/**
 * Shared payload ceilings. These are deliberately generous for normal
 * work-order and review traffic while preventing untrusted renderer/provider
 * input from becoming an unbounded main-process allocation.
 */
export const MAX_PROTOCOL_INPUT_BYTES = 1_048_576;
export const MAX_PROTOCOL_STRING_BYTES = 65_536;
export const MAX_PROTOCOL_ARRAY_ITEMS = 512;
export const MAX_CONTEXT_FILES = 128;
export const MAX_PROVIDER_CANDIDATES = 64;
export const MAX_DURABLE_JSON_BYTES = 2_097_152;

export class PayloadLimitError extends Error {
  public readonly code = 'PAYLOAD_LIMIT_EXCEEDED' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'PayloadLimitError';
  }
}

/** Count encoded bytes, never JavaScript UTF-16 code units. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isWithinByteLimit(value: string, maxBytes: number): boolean {
  return byteLength(value) <= maxBytes;
}

export function assertByteLimit(value: string, maxBytes: number, label: string): void {
  const actualBytes = byteLength(value);
  if (actualBytes > maxBytes) {
    throw new PayloadLimitError(`${label} exceeds the ${maxBytes}-byte limit (received ${actualBytes} bytes).`);
  }
}

/** Apply a byte limit while retaining the normal Zod string APIs. */
export function boundedString(schema: z.ZodString, maxBytes = MAX_PROTOCOL_STRING_BYTES): z.ZodEffects<z.ZodString> {
  return schema.superRefine((value, ctx) => {
    if (!isWithinByteLimit(value, maxBytes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'string',
        inclusive: true,
        maximum: maxBytes,
        message: `String exceeds the ${maxBytes}-byte limit.`,
      });
    }
  });
}

/**
 * Add the same UTF-8 ceiling to an already refined string schema.  Some
 * canonical schemas carry path/format refinements that cannot be rebuilt from
 * a plain `z.string()` without accidentally dropping those invariants.
 */
export function boundedRefinedString<T extends z.ZodTypeAny>(
  schema: T,
  maxBytes = MAX_PROTOCOL_STRING_BYTES,
  label = 'String'
): z.ZodEffects<T> {
  return schema.superRefine((value, ctx) => {
    if (typeof value === 'string' && !isWithinByteLimit(value, maxBytes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'string',
        inclusive: true,
        maximum: maxBytes,
        message: `${label} exceeds the ${maxBytes}-byte limit.`,
      });
    }
  });
}

export function boundedArray<T extends z.ZodTypeAny>(schema: z.ZodArray<T>, maxItems: number): z.ZodArray<T> {
  return schema.max(maxItems, `Array cannot contain more than ${maxItems} items.`);
}

/** Serialize durable JSON only after enforcing its encoded byte ceiling. */
export function stringifyBoundedJson(value: unknown, maxBytes = MAX_DURABLE_JSON_BYTES, label = 'JSON payload'): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new PayloadLimitError(`${label} cannot be serialized: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof serialized !== 'string') {
    throw new PayloadLimitError(`${label} must serialize to a JSON value.`);
  }
  assertByteLimit(serialized, maxBytes, label);
  return serialized;
}
