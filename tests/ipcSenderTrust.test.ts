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
  };

  beforeEach(() => {
    handlers.clear();
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

  it('protects project revision policy handlers with the same sender boundary', async () => {
    for (const channel of ['settings:getMaxRevisions', 'settings:saveMaxRevisions']) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await expect(
        handler!({ senderFrame: { url: 'https://remote.example/' } }, { projectId: 'p1', maxRevisions: 1 }),
      ).rejects.toMatchObject({ code: 'IPC_SENDER_UNTRUSTED' });
    }
  });
});
