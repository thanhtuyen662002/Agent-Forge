import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parsePlanProtocol } from '../src/core/protocol/planProtocol';
import { MAX_PLAN_TASKS, ManagerProtocolSchema } from '../src/core/types/protocols';

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

  it('accepts a plan of up to 60 tasks for a project planned from several milestones (#334)', () => {
    const plan = (count: number) => JSON.stringify({ protocol: 'plan.v1', message_id: 'm', project_id: 'p', contract_sha256: 'a'.repeat(64),
      tasks: Array.from({ length: count }, (_, index) => ({ title: `Task ${index + 1}`, acceptance_criteria: ['done'] })) });
    expect(parsePlanProtocol(plan(21)).success).toBe(true);
    expect(parsePlanProtocol(plan(MAX_PLAN_TASKS)).success).toBe(true);
    expect(parsePlanProtocol(plan(MAX_PLAN_TASKS + 1))).toMatchObject({ success: false, reasonCode: 'PLAN_PROTOCOL_INVALID' });
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

/** The second trial run: Claude answered the Manager's START call with instructions as one text block. */
describe('manager.v1 instructions as one text block (#271)', () => {
  const recorded = fs.readFileSync(path.join(__dirname, 'fixtures', 'trialClaudeManagerResult.txt'), 'utf8');

  it('accepts the recorded Claude decision and splits its instructions into lines', async () => {
    const { ProtocolParser } = await import('../src/core/protocol/parser');
    expect(JSON.parse(recorded).instructions).toEqual(expect.any(String));
    const parsed = ProtocolParser.parse(recorded);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.type).toBe('manager.v1');
    if (parsed.data?.type !== 'manager.v1') return;
    const data = parsed.data.data;
    expect(data.decision).toBe('EXECUTE');
    expect(data.instructions).toHaveLength(5);
    expect(data.instructions[2]).toContain('Do not modify run-tests.js');
  });

  it('still rejects instructions that are neither text nor a list of text', () => {
    const base = { protocol: 'manager.v1', message_id: 'm', project_id: 'p', task_id: 't', decision: 'EXECUTE' };
    expect(ManagerProtocolSchema.safeParse({ ...base, instructions: 42 }).success).toBe(false);
    expect(ManagerProtocolSchema.safeParse({ ...base, instructions: [{ step: 1 }] }).success).toBe(false);
    expect(ManagerProtocolSchema.safeParse({ ...base, instructions: '  \n ' }).success && ManagerProtocolSchema.parse({ ...base, instructions: '  \n ' }).instructions).toEqual([]);
  });
});

describe('coder.v1 and review.v1 tolerate the same slips (#271)', () => {
  it('upper-cases status, verdict and severity, and splits text lists into lines', async () => {
    const { CoderProtocolSchema, ReviewProtocolSchema } = await import('../src/core/types/protocols');
    const coder = CoderProtocolSchema.parse({ protocol: 'coder.v1', message_id: 'm', project_id: 'p', task_id: 't', status: 'completed',
      completed: 'Added slugify\nAdded tests', files_claimed_changed: ['src/text.js'], expected_task_state: 'coding' });
    expect([coder.status, coder.completed, coder.expected_task_state]).toEqual(['COMPLETED', ['Added slugify', 'Added tests'], 'CODING']);
    const review = ReviewProtocolSchema.parse({ protocol: 'review.v1', message_id: 'm', project_id: 'p', task_id: 't', task_revision: 0, verdict: 'fix_required',
      summary: 's', issues: [{ severity: 'required', title: 'x', description: 'y' }], reviewed_head_sha: 'a'.repeat(40), reviewed_snapshot_sha: 'b'.repeat(64) });
    expect([review.verdict, review.issues[0].severity]).toEqual(['FIX_REQUIRED', 'REQUIRED']);
    expect(ReviewProtocolSchema.safeParse({ ...review, verdict: 'maybe' }).success).toBe(false);
  });
});

/** The fourth trial run: Codex wrote the code but reported coder.v1 without message_id and project_id. */
describe('coder.v1 identifiers completed for the request\'s own task (#277)', () => {
  const recorded = fs.readFileSync(path.join(__dirname, 'fixtures', 'trialCodexCoderResult.txt'), 'utf8');
  const request = { taskId: 'TSK-1738B35F', projectId: 'PROJ-61404592' };

  it('accepts the recorded Codex report once the missing identifiers are filled in', async () => {
    const { completeCoderIdentifiers } = await import('../src/core/adapters/LocalCliAdapterBase');
    const { ProtocolParser } = await import('../src/core/protocol/parser');
    expect(ProtocolParser.parse(recorded).success).toBe(false); // As the trial saw it.
    const parsed = ProtocolParser.parse(completeCoderIdentifiers(recorded, request, 'exec-1'));
    expect(parsed.success).toBe(true);
    if (parsed.data?.type !== 'coder.v1') throw new Error('not coder.v1');
    expect(parsed.data.data).toMatchObject({ project_id: 'PROJ-61404592', task_id: 'TSK-1738B35F', message_id: 'coder-exec-1', status: 'COMPLETED' });
  });

  it('never rewrites a report for another task or project, and keeps a given message id', async () => {
    const { completeCoderIdentifiers } = await import('../src/core/adapters/LocalCliAdapterBase');
    const report = (extra: Record<string, unknown>) => JSON.stringify({ protocol: 'coder.v1', status: 'COMPLETED', ...extra });
    const otherTask = report({ task_id: 'TSK-OTHER' });
    expect(completeCoderIdentifiers(otherTask, request, 'e')).toBe(otherTask);
    const otherProject = report({ task_id: 'TSK-1738B35F', project_id: 'PROJ-OTHER' });
    expect(completeCoderIdentifiers(otherProject, request, 'e')).toBe(otherProject);
    expect(JSON.parse(completeCoderIdentifiers(report({ task_id: 'TSK-1738B35F', message_id: 'm-7' }), request, 'e')).message_id).toBe('m-7');
    expect(completeCoderIdentifiers('not json', request, 'e')).toBe('not json');
  });
});
