import { describe, expect, it, vi } from 'vitest';
import { UiActionRunner, normalizeUiActionReply, uiActionFailureKey, normalizeVerificationReply, normalizeEmergencyReply } from '../src/ui/actionState';

describe('truthful UI mutation results', () => {
  it.each([undefined, null, false, true, [], 'success', {}, { success: 'true' }, { success: 1 }])('rejects malformed acknowledgement %#', (reply) => {
    expect(normalizeUiActionReply(reply)).toEqual({ success: false, code: 'INVALID_RESPONSE' });
  });
  it('requires explicit IPC success and validates required entity payloads', () => {
    expect(normalizeUiActionReply({ success: false, error: 'private exception' })).toEqual({ success: false, code: 'IPC_FAILED' });
    expect(normalizeUiActionReply({ success: true })).toEqual({ success: true, data: undefined });
    expect(normalizeUiActionReply({ success: true }, 'project')).toEqual({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeUiActionReply({ success: true, task: { id: 'T' } }, 'task')).toEqual({ success: false, code: 'INVALID_RESPONSE' });
    const project = { id: 'P', name: 'Project' };
    expect(normalizeUiActionReply({ success: true, project }, 'project')).toEqual({ success: true, data: project });
    expect(normalizeUiActionReply(new Proxy({}, { get() { throw new Error('private exception'); } }))).toEqual({ success: false, code: 'INVALID_RESPONSE' });
  });
  it('never invokes mutations in browser preview', async () => {
    const invoke = vi.fn();
    const pending = vi.fn();
    expect(await new UiActionRunner(false, pending).run('createTask', invoke)).toEqual({ success: false, code: 'DESKTOP_REQUIRED' });
    expect(invoke).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
  });
  it('releases the synchronous lock after IPC rejection and permits an explicit retry', async () => {
    const states: string[][] = [];
    const runner = new UiActionRunner(true, (pending) => states.push([...pending]));
    expect(await runner.run('importContract', async () => { throw new Error('private secret'); })).toEqual({ success: false, code: 'IPC_REJECTED' });
    expect(await runner.run('importContract', async () => ({ success: true }))).toMatchObject({ success: true });
    expect(states).toEqual([['importContract'], [], ['importContract'], []]);
  });
  it('blocks repeated clicks through IPC and the following read-model refresh', async () => {
    let finishIpc!: (reply: unknown) => void;
    let finishRefresh!: () => void;
    const invoke = vi.fn(() => new Promise<unknown>((resolve) => { finishIpc = resolve; }));
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    const runner = new UiActionRunner(true, () => {});
    const first = runner.run('projectTransition', invoke, undefined, refresh);
    expect(await runner.run('projectTransition', invoke)).toEqual({ success: false, code: 'ACTION_PENDING' });
    finishIpc({ success: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    expect(await runner.run('projectTransition', invoke)).toEqual({ success: false, code: 'ACTION_PENDING' });
    expect(invoke).toHaveBeenCalledOnce();
    finishRefresh();
    expect(await first).toMatchObject({ success: true });
    expect(await runner.run('projectTransition', async () => ({ success: true }))).toMatchObject({ success: true });
  });
  it('does not refresh after failure or reclassify a committed write when refresh fails', async () => {
    const refresh = vi.fn(async () => { throw new Error('refresh failed'); });
    const runner = new UiActionRunner(true, () => {});
    expect(await runner.run('createProject', async () => ({ success: false }), undefined, refresh)).toEqual({ success: false, code: 'IPC_FAILED' });
    expect(refresh).not.toHaveBeenCalled();
    expect(await runner.run('importContract', async () => ({ success: true }), undefined, refresh)).toMatchObject({ success: true });
    expect(refresh).toHaveBeenCalledOnce();
    expect(uiActionFailureKey('IPC_FAILED')).toBe('actions.failed');
  });
});

describe('validated backend observations', () => {
  const executionId = '12345678-1234-1234-1234-123456789012';
  const run = { id: 'RUN', task_id: 'TASK', passed_count: 7, failed_count: 0, skipped_count: 2, duration_ms: 16,
    exit_code: 0, created_at: '2026-10-08T00:00:00Z', command: 'private-command', pending_evidence: { raw_payload: 'private-output' } };
  const reply = { success: true, taskId: 'TASK', executionId, testRun: run };
  const normalize = (value: unknown) => normalizeVerificationReply(value, 'PROJECT', 'TASK', executionId);

  it('projects actual ValidationFlowResult counts and preserves failure observations without declaring a pass', () => {
    expect(normalize(reply)).toEqual({ success: true, data: { projectId: 'PROJECT', taskId: 'TASK', executionId,
      verificationPassed: true, testRun: { id: 'RUN', task_id: 'TASK', passed_count: 7, failed_count: 0, skipped_count: 2,
        duration_ms: 16, exit_code: 0, created_at: run.created_at } } });
    const failed = normalize({ ...reply, success: false, testRun: { ...run, failed_count: 3, exit_code: 1 } });
    expect(failed).toMatchObject({ success: true, data: { verificationPassed: false, testRun: { passed_count: 7, failed_count: 3, exit_code: 1 } } });
    expect(JSON.stringify(failed)).not.toContain('private-');
  });
  it.each([null, {}, run, { ...reply, taskId: 'OTHER' }, { ...reply, executionId: 'prior-request' },
    { ...reply, testRun: { ...run, task_id: 'OTHER' } }, { ...reply, testRun: { ...run, failed_count: -1 } },
    { ...reply, testRun: { ...run, passed_count: NaN } }, { ...reply, testRun: { ...run, duration_ms: Infinity } },
    { ...reply, testRun: { ...run, exit_code: '0' } }, { ...reply, testRun: { ...run, created_at: 'now' } },
    { ...reply, testRun: { ...run, failed_count: 1 } }, new Proxy({}, { get() { throw new Error('private'); } })
  ])('rejects malformed, stale or contradictory test observations %#', value => {
    expect(normalize(value)).toEqual({ success: false, code: 'INVALID_RESPONSE' });
  });
  it('preserves typed capability rejection and stale settlement without exposing diagnostic payloads', () => {
    expect(normalize({ success: false, error: 'COMMAND_POLICY_REJECTED', privateDetail: 'private-output' })).toEqual({ success: false, code: 'VERIFICATION_REJECTED' });
    expect(normalize({ ...reply, success: false, stale: true })).toEqual({ success: false, code: 'STALE_CONTEXT' });
  });
  it('projects emergency observations and never invents missing uncertainty or counts', () => {
    const result = { processesTerminated: 2, tasksPaused: ['T'], projectsPaused: ['P', 'Q'], timestamp: run.created_at,
      unprovenProcesses: 1, allTerminatedProven: false, stopEpochs: { P: 2 }, privateDetail: 'private-output' };
    expect(normalizeEmergencyReply(result)).toEqual({ success: true, data: { processesTerminated: 2, tasksPaused: 1,
      projectsPaused: 2, timestamp: run.created_at, unprovenProcesses: 1, allTerminatedProven: false } });
    for (const value of [null, {}, { ...result, tasksPaused: undefined }, { ...result, tasksPaused: ['T', 'T'] },
      { ...result, projectsPaused: 0 }, { ...result, allTerminatedProven: undefined }, { ...result, allTerminatedProven: true },
      { ...result, processesTerminated: -1 }, { ...result, unprovenProcesses: 1.5 }, { ...result, timestamp: 'now' }]) {
      expect(normalizeEmergencyReply(value)).toEqual({ success: false, code: 'INVALID_RESPONSE' });
    }
  });
  it('bounds pending verification independently from emergency and ordinary project operations', async () => {
    const runner = new UiActionRunner(true, () => {});
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const first = runner.runObserved('runVerification', invoke, normalize);
    expect(await runner.runObserved('runVerification', invoke, normalize)).toEqual({ success: false, code: 'ACTION_PENDING' });
    expect(await runner.run('emergencyStop', async () => ({ success: true }))).toMatchObject({ success: true });
    expect(await runner.run('projectTransition', async () => ({ success: true }))).toMatchObject({ success: true });
    finish(reply);
    expect(await first).toMatchObject({ success: true });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
