import { describe, expect, it } from 'vitest';
import {
  MAX_PROTOCOL_INPUT_BYTES,
  MAX_PROTOCOL_ARRAY_ITEMS,
  MAX_PROVIDER_CANDIDATES,
  byteLength,
  isWithinByteLimit,
} from '../src/core/protocol/limits';
import { ProtocolParser } from '../src/core/protocol/parser';

describe('bounded protocol payloads', () => {
  it('counts UTF-8 bytes rather than JavaScript code units', () => {
    expect(byteLength('�')).toBe(4);
    expect(isWithinByteLimit('�', 4)).toBe(true);
    expect(isWithinByteLimit('�', 3)).toBe(false);
  });

  it('rejects oversized raw input before JSON parsing', () => {
    const oversized = 'x'.repeat(MAX_PROTOCOL_INPUT_BYTES + 1);
    const result = ProtocolParser.parse(oversized);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/size|large|limit|bytes/i);
  });

  it('keeps operational collection limits explicit', () => {
    expect(MAX_PROTOCOL_ARRAY_ITEMS).toBeGreaterThan(0);
    expect(MAX_PROVIDER_CANDIDATES).toBeLessThanOrEqual(MAX_PROTOCOL_ARRAY_ITEMS);
  });
});
