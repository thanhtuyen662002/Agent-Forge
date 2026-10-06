import { describe, expect, it, vi } from 'vitest';
import { UiActionRunner, normalizeUiActionReply, uiActionFailureKey } from '../src/ui/actionState';

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
