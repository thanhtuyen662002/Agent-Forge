import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { dialog } from 'electron';
import { GitService } from '../src/core/services/GitService';
import { RepositorySelectionService } from '../src/core/services/RepositorySelectionService';
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
  const fixtures: string[] = [];
  const projectService = { createProject: vi.fn((name: string, _: string, repositoryPath: string) => ({ id: 'new-project', name, repository_path: repositoryPath })) };
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
    RepositorySelectionService.clearTokens();
    registerIpcHandlers(
      repo as any,
      projectService as any,
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

  afterEach(() => {
    vi.restoreAllMocks();
    RepositorySelectionService.clearTokens();
    for (const fixture of fixtures.splice(0)) {
      if (fs.realpathSync.native(fixture) !== fixture || !path.basename(fixture).startsWith('af-ipc-root-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  function repositoryFixture(): { fixture: string; root: string } {
    const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-ipc-root-')));
    fixtures.push(fixture);
    const root = path.join(fixture, 'repo'); fs.mkdirSync(root);
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
    git(['init', '-q']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
    return { fixture, root };
  }

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

  it('selects a real canonical Git repository and consumes the native capability for creation', async () => {
    const { root } = repositoryFixture();
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    const event = { senderFrame: { url: 'http://localhost:5173/' } };
    const selection = await handlers.get('dialog:selectRepository')!(event, undefined) as { success: boolean; selectionId: string; displayPath: string };
    expect(selection.success).toBe(true);
    expect(selection.displayPath).toBe(root);
    expect(await handlers.get('project:create')!(event, { name: 'Selected project', repositorySelectionId: selection.selectionId })).toMatchObject({ success: true });
    expect(projectService.createProject).toHaveBeenCalledTimes(1);
    expect(projectService.createProject.mock.calls[0][2]).toBe(root);
  });

  it('returns a typed junction/alias selection error before invoking Git', async () => {
    const { fixture, root } = repositoryFixture();
    const alias = path.join(fixture, 'alias');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [alias] });
    const status = vi.spyOn(GitService, 'getStatus');
    const result = await handlers.get('dialog:selectRepository')!({ senderFrame: { url: 'http://localhost:5173/' } }, undefined);
    expect(result).toMatchObject({ success: false, errorCode: 'REPOSITORY_ROOT_ALIAS' });
    expect(status).not.toHaveBeenCalled();
    expect(projectService.createProject).not.toHaveBeenCalled();
  });

  it('does not issue a capability after the selected root changes during Git validation', async () => {
    const { root } = repositoryFixture();
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    const originalStatus = GitService.getStatus.bind(GitService);
    vi.spyOn(GitService, 'getStatus').mockImplementationOnce(async (...args) => {
      const result = await originalStatus(...args);
      expect(result.status).toBe('SUCCESS');
      fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
      return result;
    });
    expect(await handlers.get('dialog:selectRepository')!({ senderFrame: { url: 'http://localhost:5173/' } }, undefined))
      .toMatchObject({ success: false, errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED' });
    expect(projectService.createProject).not.toHaveBeenCalled();
  });

  it('rejects a post-consumption root replacement before project persistence', async () => {
    const { root } = repositoryFixture();
    const token = RepositorySelectionService.issueToken(root);
    const originalStatus = GitService.getStatus.bind(GitService);
    vi.spyOn(GitService, 'getStatus').mockImplementationOnce(async (...args) => {
      const result = await originalStatus(...args);
      expect(result.status).toBe('SUCCESS');
      fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
      return result;
    });
    expect(await handlers.get('project:create')!({ senderFrame: { url: 'http://localhost:5173/' } }, {
      name: 'Stale selected project', repositorySelectionId: token.selectionId,
    })).toMatchObject({ success: false, errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED' });
    expect(projectService.createProject).not.toHaveBeenCalled();
    expect(RepositorySelectionService.consumeToken(token.selectionId).success).toBe(false);
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
