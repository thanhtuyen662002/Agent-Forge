import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { IUpdateAdapter, UpdateCheckResult, UpdateService } from '../src/core/services/UpdateService';

class FakeUpdateAdapter extends EventEmitter implements IUpdateAdapter {
  public quitThrows = false;
  public checkPromise: Promise<UpdateCheckResult | null> = Promise.resolve(null);
  public downloadPromise: Promise<void> = Promise.resolve();
  public installCalls = 0;

  checkForUpdates(): Promise<UpdateCheckResult | null> { return this.checkPromise; }
  downloadUpdate(): Promise<void> { return this.downloadPromise; }
  quitAndInstall(): void {
    this.installCalls += 1;
    if (this.quitThrows) throw new Error('download artifact Bearer secret-token is invalid');
  }
}

const service = (adapter: FakeUpdateAdapter): UpdateService => new UpdateService({
  currentVersion: '1.0.0',
  isPackaged: true,
  adapter,
});

describe('UpdateService adapter lifecycle', () => {
  it('detaches replaced adapter listeners and fences stale events', () => {
    const first = new FakeUpdateAdapter();
    const second = new FakeUpdateAdapter();
    const updates = service(first);

    expect(first.listenerCount('update-available')).toBe(1);
    updates.setAdapter(second);
    expect(first.listenerCount('update-available')).toBe(0);
    expect(second.listenerCount('update-available')).toBe(1);
    expect(updates.getState().state).toBe('IDLE');

    first.emit('update-available', { version: '9.9.9' });
    expect(updates.getState().state).toBe('IDLE');
    second.emit('update-available', { version: '2.0.0' });
    expect(updates.getState().state).toBe('UPDATE_AVAILABLE');
    expect(updates.getState().updateInfo?.version).toBe('2.0.0');
  });

  it('ignores a pending check result from an adapter replaced during the request', async () => {
    const first = new FakeUpdateAdapter();
    let resolveCheck!: (result: UpdateCheckResult | null) => void;
    first.checkPromise = new Promise((resolve) => { resolveCheck = resolve; });
    const second = new FakeUpdateAdapter();
    const updates = service(first);

    const pending = updates.checkForUpdates();
    updates.setAdapter(second);
    resolveCheck({ updateInfo: { version: '9.9.9' } });
    await pending;

    expect(updates.getState().state).toBe('IDLE');
    expect(updates.getState().updateInfo).toBeNull();
  });

  it('converts synchronous install failure to a sanitized retryable error state', () => {
    const adapter = new FakeUpdateAdapter();
    adapter.quitThrows = true;
    const updates = service(adapter);
    adapter.emit('update-downloaded', { version: '2.0.0' });

    expect(() => updates.installAndRestart()).not.toThrow();
    expect(adapter.installCalls).toBe(1);
    expect(updates.getState().state).toBe('ERROR');
    expect(updates.getState().error).toContain('[REDACTED]');
    expect(updates.getState().error).not.toContain('secret-token');

    // A new download can retry after the failed install; the service is not
    // permanently stuck in INSTALLING.
    adapter.quitThrows = false;
    adapter.emit('update-downloaded', { version: '2.0.0' });
    expect(() => updates.installAndRestart()).not.toThrow();
    expect(adapter.installCalls).toBe(2);
    expect(updates.getState().state).toBe('INSTALLING');
  });
});
