import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandlers, IpcSenderTrustError } from '../src/electron/ipcHandlers';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, listener);
    },
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  app: {
    getPath: vi.fn(),
  },
}));

describe('privileged IPC sender trust boundary', () => {
  const repo = {
    getAllProjects: vi.fn(() => []),
    getProject: vi.fn((id: string) => ({ id })),
    getProjectMaxRevisions: vi.fn(() => 3),
    setProjectMaxRevisions: vi.fn((_: string, value: number) => value),
    getProviderResource: vi.fn((id: string) => id === 'res-1' ? { id } : null),
    updateProviderResourceQuota: vi.fn(),
    runInImmediateTransaction: vi.fn((fn: () => unknown) => fn()),
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerIpcHandlers(
      repo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
    );
  });

  it('rejects missing, synthetic, remote, and lookalike sender frames before handler logic', async () => {
    const handler = handlers.get('project:list');
    expect(handler).toBeDefined();

    for (const event of [
      null,
      {},
      { sender: { getURL: () => 'http://localhost:5173/' } },
      { senderFrame: null },
      { senderFrame: { url: 'https://remote.example/' } },
      { senderFrame: { url: 'http://localhost.evil:5173/' } },
    ]) {
      await expect(handler!(event, undefined)).rejects.toBeInstanceOf(IpcSenderTrustError);
      await expect(handler!(event, undefined)).rejects.toMatchObject({ code: 'IPC_SENDER_UNTRUSTED' });
    }
    expect(repo.getAllProjects).not.toHaveBeenCalled();
  });

  it('allows an exact trusted renderer origin and invokes the handler', async () => {
    const handler = handlers.get('project:list');
    expect(handler).toBeDefined();

    await expect(
      handler!({ senderFrame: { url: 'http://localhost:5173/tasks' } }, undefined),
    ).resolves.toEqual([]);
    expect(repo.getAllProjects).toHaveBeenCalledTimes(1);
  });

  it('confirms quota mutation only for an existing resource inside the immediate transaction', async () => {
    const handler = handlers.get('providers:updateResourceQuota')!;
    const event = { senderFrame: { url: 'http://localhost:5173/capacity' } };
    const payload = { id: 'res-1', remaining: 50, total: 100, source: 'MANUAL', confidence: 1 };
    await expect(handler(event, { ...payload, id: 'missing' })).resolves.toEqual({ success: false, error: 'RESOURCE_NOT_FOUND' });
    expect(repo.updateProviderResourceQuota).not.toHaveBeenCalled();
    await expect(handler(event, payload)).resolves.toEqual({ success: true });
    expect(repo.updateProviderResourceQuota).toHaveBeenCalledWith('res-1', 50, 100, 'MANUAL', 1);
    expect(repo.runInImmediateTransaction).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid quota and untrusted senders before opening a mutation transaction', async () => {
    const handler = handlers.get('providers:updateResourceQuota')!;
    const payload = { id: 'res-1', remaining: -1, total: 100, source: 'MANUAL', confidence: 1 };
    const result = await handler({ senderFrame: { url: 'http://localhost:5173/capacity' } }, payload);
    expect(result).toMatchObject({ success: false });
    await expect(handler({ senderFrame: { url: 'https://remote.example/' } }, payload)).rejects.toBeInstanceOf(IpcSenderTrustError);
    expect(repo.runInImmediateTransaction).not.toHaveBeenCalled();
    expect(repo.updateProviderResourceQuota).not.toHaveBeenCalled();
  });

  it('propagates quota persistence failure without acknowledging success', async () => {
    const handler = handlers.get('providers:updateResourceQuota')!;
    repo.updateProviderResourceQuota.mockImplementationOnce(() => { throw new Error('injected storage failure'); });
    await expect(handler({ senderFrame: { url: 'http://localhost:5173/capacity' } }, {
      id: 'res-1', remaining: 50, total: 100, source: 'MANUAL', confidence: 1,
    })).rejects.toThrow('injected storage failure');
  });

  it('protects project revision policy handlers with the same sender boundary', async () => {
    for (const channel of ['settings:getMaxRevisions', 'settings:saveMaxRevisions']) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await expect(
        handler!({ senderFrame: { url: 'https://remote.example/' } }, { projectId: 'p1', maxRevisions: 1 }),
      ).rejects.toMatchObject({ code: 'IPC_SENDER_UNTRUSTED' });
    }
  });

  it('loads and saves revision policy only through trusted IPC, including persistence failures', async () => {
    const trustedEvent = { senderFrame: { url: 'http://localhost:5173/settings' } };
    const getHandler = handlers.get('settings:getMaxRevisions');
    const saveHandler = handlers.get('settings:saveMaxRevisions');
    expect(getHandler).toBeDefined();
    expect(saveHandler).toBeDefined();

    await expect(getHandler!(trustedEvent, { projectId: 'p1' })).resolves.toEqual({
      success: true,
      maxRevisions: 3,
    });
    await expect(saveHandler!(trustedEvent, { projectId: 'p1', maxRevisions: 7 })).resolves.toEqual({
      success: true,
      maxRevisions: 7,
    });
    expect(repo.setProjectMaxRevisions).toHaveBeenCalledWith('p1', 7);

    repo.setProjectMaxRevisions.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    await expect(saveHandler!(trustedEvent, { projectId: 'p1', maxRevisions: 8 })).resolves.toEqual({
      success: false,
      error: 'database unavailable',
    });
  });
});
