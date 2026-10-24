import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, listener);
    },
  },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn() },
}));

import { registerIpcHandlers } from '../src/electron/ipcHandlers';

describe('Issue #130 renderer dispatch admission boundary', () => {
  const providerDispatchService = {
    dispatchManualBridge: vi.fn(async (authorizationId: string) => ({ mode: 'MANUAL_BRIDGE', authorizationId })),
    dispatchProductBound: vi.fn(async (authorizationId: string) => ({ mode: 'PRODUCT_BOUND', authorizationId })),
  };

  // Only the owner-trash fence reads the repository before admission.
  const repo = {
    getExecutionAuthorization: vi.fn((id: string) => ({ id, task_id: `task-for-${id}` })),
    isProjectTrashed: vi.fn(() => false),
    isTaskTrashed: vi.fn((taskId: string) => taskId === 'task-for-auth-trashed'),
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
      {} as any,
      {} as any,
      providerDispatchService as any,
      {} as any,
      {} as any,
    );
  });

  const trustedRenderer = { senderFrame: { url: 'http://localhost:5173/tasks' } };

  it('routes explicit Manual Bridge dispatch only to the manual admission method', async () => {
    const handler = handlers.get('routing:dispatchAuthorization');
    expect(handler).toBeDefined();

    await expect(
      handler!(trustedRenderer, { authorizationId: 'auth-manual', executionMode: 'MANUAL_BRIDGE' }),
    ).resolves.toEqual({
      success: true,
      result: { mode: 'MANUAL_BRIDGE', authorizationId: 'auth-manual' },
    });
    expect(providerDispatchService.dispatchManualBridge).toHaveBeenCalledWith('auth-manual');
    expect(providerDispatchService.dispatchProductBound).not.toHaveBeenCalled();
  });

  it('routes explicit product-bound dispatch only to the product admission method', async () => {
    const handler = handlers.get('routing:dispatchAuthorization');
    expect(handler).toBeDefined();

    await expect(
      handler!(trustedRenderer, { authorizationId: 'auth-product', executionMode: 'PRODUCT_BOUND' }),
    ).resolves.toEqual({
      success: true,
      result: { mode: 'PRODUCT_BOUND', authorizationId: 'auth-product' },
    });
    expect(providerDispatchService.dispatchProductBound).toHaveBeenCalledWith('auth-product');
    expect(providerDispatchService.dispatchManualBridge).not.toHaveBeenCalled();
  });

  it('refuses to dispatch an authorization whose task is in the owner trash', async () => {
    const handler = handlers.get('routing:dispatchAuthorization');
    await expect(
      handler!(trustedRenderer, { authorizationId: 'auth-trashed', executionMode: 'PRODUCT_BOUND' }),
    ).resolves.toMatchObject({ success: false, errorCode: 'ENTITY_IN_TRASH' });
    expect(repo.isTaskTrashed).toHaveBeenCalledWith('task-for-auth-trashed');
    expect(providerDispatchService.dispatchManualBridge).not.toHaveBeenCalled();
    expect(providerDispatchService.dispatchProductBound).not.toHaveBeenCalled();
  });

  it('rejects a legacy dispatch payload before invoking either admission method', async () => {
    const handler = handlers.get('routing:dispatchAuthorization');
    expect(handler).toBeDefined();

    await expect(
      handler!(trustedRenderer, { authorizationId: 'auth-legacy' }),
    ).resolves.toMatchObject({ success: false });
    expect(providerDispatchService.dispatchManualBridge).not.toHaveBeenCalled();
    expect(providerDispatchService.dispatchProductBound).not.toHaveBeenCalled();
  });
});
