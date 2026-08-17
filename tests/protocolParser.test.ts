import { describe, it, expect } from 'vitest';
import { ProtocolParser } from '../src/core/protocol/parser';

describe('ProtocolParser', () => {
  it('should parse raw JSON manager.v1 protocol', () => {
    const raw = JSON.stringify({
      protocol: 'manager.v1',
      message_id: 'msg-001',
      project_id: 'PROJ-1',
      task_id: 'TASK-1',
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: ['Do step 1'],
      acceptance_criteria: ['Criterion A'],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    });

    const result = ProtocolParser.parse(raw);
    expect(result.success).toBe(true);
    expect(result.protocolType).toBe('manager.v1');
    if (result.data?.type === 'manager.v1') {
      expect(result.data.data.decision).toBe('EXECUTE');
      expect(result.data.data.message_id).toBe('msg-001');
    }
  });

  it('should extract JSON from Markdown code fences', () => {
    const markdown = `
Here is my review for the task:

\`\`\`json
{
  "protocol": "coder.v1",
  "message_id": "msg-cdr-002",
  "project_id": "PROJ-1",
  "task_id": "TASK-1",
  "attempt": 1,
  "status": "COMPLETED",
  "completed": ["Implemented auth token check"],
  "files_claimed_changed": ["src/auth.ts"],
  "tests_claimed": ["All 10 tests passed"],
  "review_requested": true,
  "expected_task_state": "CODING",
  "expected_revision": 0
}
\`\`\`

Let me know if you need anything else!
    `;

    const result = ProtocolParser.parse(markdown);
    expect(result.success).toBe(true);
    expect(result.protocolType).toBe('coder.v1');
    if (result.data?.type === 'coder.v1') {
      expect(result.data.data.status).toBe('COMPLETED');
      expect(result.data.data.files_claimed_changed).toContain('src/auth.ts');
    }
  });

  it('should extract JSON embedded in conversational prose', () => {
    const prose = `
I have decided to approve this. Protocol packet:
{
  "protocol": "manager.v1",
  "message_id": "msg-003",
  "project_id": "PROJ-1",
  "task_id": "TASK-1",
  "decision": "PASS",
  "expected_task_state": "REVIEWING",
  "expected_revision": 0
}
Thank you.
    `;

    const result = ProtocolParser.parse(prose);
    expect(result.success).toBe(true);
    expect(result.protocolType).toBe('manager.v1');
    if (result.data?.type === 'manager.v1') {
      expect(result.data.data.decision).toBe('PASS');
    }
  });

  it('should reject invalid JSON or missing protocol discriminator', () => {
    const invalid = '{ "foo": "bar" }';
    const result = ProtocolParser.parse(invalid);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required "protocol"');
  });
});
