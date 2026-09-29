import { describe, expect, it } from 'vitest';
import {
  MAX_PROTOCOL_INPUT_BYTES,
  MAX_PROTOCOL_ARRAY_ITEMS,
  MAX_PROVIDER_CANDIDATES,
  MAX_PROTOCOL_STRING_BYTES,
  MAX_DURABLE_JSON_BYTES,
  byteLength,
  isWithinByteLimit,
  stringifyBoundedJson,
} from '../src/core/protocol/limits';
import { ProtocolParser } from '../src/core/protocol/parser';
import { ParseProtocolIpcSchema, RouteTaskIpcSchema } from '../src/core/types/ipc';
import { ManagerProtocolSchema } from '../src/core/types/protocols';

describe('bounded protocol payloads', () => {
  it('counts UTF-8 bytes rather than JavaScript code units', () => {
    expect(byteLength(String.fromCodePoint(0x1F600))).toBe(4);
    expect(isWithinByteLimit(String.fromCodePoint(0x1F600), 4)).toBe(true);
    expect(isWithinByteLimit(String.fromCodePoint(0x1F600), 3)).toBe(false);
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

  it('bounds IPC protocol text by UTF-8 bytes', () => {
    const oversized = 'x'.repeat(MAX_PROTOCOL_INPUT_BYTES + 1);
    expect(ParseProtocolIpcSchema.safeParse({ rawInput: oversized }).success).toBe(false);
    const unicodeField = String.fromCodePoint(0x1F600).repeat(Math.floor(MAX_PROTOCOL_STRING_BYTES / 4) + 1);
    expect(
      ManagerProtocolSchema.safeParse({
        protocol: 'manager.v1',
        message_id: 'message-1',
        project_id: 'project-1',
        decision: 'PASS',
        instructions: [unicodeField],
      }).success
    ).toBe(false);
  });

  it('bounds candidate arrays and durable JSON serialization', () => {
    const tooManyCandidates = Array.from({ length: MAX_PROVIDER_CANDIDATES + 1 }, (_, index) => `resource-${index}`);
    expect(
      RouteTaskIpcSchema.safeParse({
        projectId: 'project-1',
        taskId: 'task-1',
        candidateResourceIds: tooManyCandidates,
      }).success
    ).toBe(false);
    expect(() => stringifyBoundedJson('x'.repeat(MAX_DURABLE_JSON_BYTES + 1))).toThrow(/limit|bytes/i);
  });
});
