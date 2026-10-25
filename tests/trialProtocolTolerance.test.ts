import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parsePlanProtocol } from '../src/core/protocol/planProtocol';
import { ManagerProtocolSchema } from '../src/core/types/protocols';

/**
 * #268: what the first real trial (2026-10-25) showed. Claude Code (sonnet)
 * answered the planning call with a correct plan.v1, but fenced in ```json,
 * followed by a sentence, and with lower-case priority/risk ("high", "low").
 */
describe('protocol tolerance found in the first real trial (#268)', () => {
  const recorded = fs.readFileSync(path.join(__dirname, 'fixtures', 'trialClaudePlanResult.txt'), 'utf8');

  it('accepts the recorded Claude plan: fenced JSON, trailing prose and lower-case enums', () => {
    expect(recorded).toContain('```json');
    expect(recorded).toContain('"priority": "high"');
    const parsed = parsePlanProtocol(recorded);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.project_id).toBe('PROJ-190E6B10');
    expect(parsed.data.tasks.map((task) => [task.priority, task.risk])).toEqual([['HIGH', 'LOW'], ['HIGH', 'LOW'], ['MEDIUM', 'LOW']]);
    expect(parsed.data.tasks[0].context_paths).toEqual(['src/text.js', 'package.json']);
  });

  it('still rejects values that are not a priority in any case', () => {
    const plan = (priority: unknown) => JSON.stringify({ protocol: 'plan.v1', message_id: 'm', project_id: 'p', contract_sha256: 'a'.repeat(64),
      tasks: [{ title: 'T', acceptance_criteria: ['done'], priority }] });
    expect(parsePlanProtocol(plan(' Critical ')).success).toBe(true);
    expect(parsePlanProtocol(plan('urgent')).success).toBe(false);
    expect(parsePlanProtocol(plan(3)).success).toBe(false);
  });

  it('applies the same case tolerance to manager.v1 priority and risk', () => {
    const decision = ManagerProtocolSchema.safeParse({ protocol: 'manager.v1', message_id: 'm', project_id: 'p', task_id: 't', decision: 'EXECUTE',
      priority: 'low', risk: 'medium', expected_task_state: 'PLANNED', expected_revision: 0 });
    expect(decision.success && [decision.data.priority, decision.data.risk]).toEqual(['LOW', 'MEDIUM']);
  });

  it('places local CLI workspaces under the canonical temporary folder', async () => {
    // A DOS short-name TEMP made Claude refuse Glob in its own workspace.
    const { getLocalCliWorkspaceBase } = await import('../src/core/adapters/LocalCliAdapterBase');
    expect(getLocalCliWorkspaceBase()).toBe(path.join(fs.realpathSync.native(os.tmpdir()), 'agent-forge-local-cli-workspaces'));
  });
});
