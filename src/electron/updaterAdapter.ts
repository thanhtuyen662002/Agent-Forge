import { EventEmitter } from 'events';
import { autoUpdater } from 'electron-updater';
import { IUpdateAdapter, UpdateCheckResult } from '../core/services/UpdateService';

/**
 * Concrete ElectronUpdaterAdapter wrapping electron-updater.
 * Configured with strict Owner-mediated controls:
 * - autoDownload = false
 * - autoInstallOnAppQuit = false
 */
export class ElectronUpdaterAdapter extends EventEmitter implements IUpdateAdapter {
  constructor() {
    super();
    // Invariants: Never auto-download or auto-install without explicit Owner action
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    // Attach native electron-updater event listeners
    autoUpdater.on('checking-for-update', () => {
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info) => {
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
      this.emit('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progressObj) => {
      this.emit('download-progress', progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.emit('update-downloaded', info);
    });

    autoUpdater.on('error', (err) => {
      this.emit('error', err);
    });
  }

  public async checkForUpdates(): Promise<UpdateCheckResult | null> {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo) {
        return null;
      }
      return {
        updateInfo: {
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate ?? undefined,
          releaseNotes: result.updateInfo.releaseNotes ?? undefined,
          releaseName: result.updateInfo.releaseName ?? undefined,
        },
      };
    } catch (err) {
      this.emit('error', err);
      return null;
    }
  }

  public async downloadUpdate(): Promise<any> {
    return autoUpdater.downloadUpdate();
  }

  public quitAndInstall(): void {
    // isSilent: false, isForceRunAfter: true
    autoUpdater.quitAndInstall(false, true);
  }
}
