import { describe, expect, it, vi } from 'vitest';

const autoUpdater = vi.hoisted(() => ({
  autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false,
  on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
}));
vi.mock('electron-updater', () => ({ autoUpdater }));

import { ElectronUpdaterAdapter } from '../src/electron/updaterAdapter';

/** #298: installed apps follow the dev channel, never downloading or installing on their own. */
describe('electron-updater adapter', () => {
  it('considers dev-channel pre-releases and keeps download and install owner-initiated', () => {
    new ElectronUpdaterAdapter();
    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });
});
