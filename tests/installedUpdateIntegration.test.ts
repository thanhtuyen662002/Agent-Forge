import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { UpdateService, IUpdateAdapter } from '../src/core/services/UpdateService';
import { EventEmitter } from 'events';

class ControlledHttpUpdaterAdapter extends EventEmitter implements IUpdateAdapter {
  private feedBaseUrl: string;
  public installedVersion: string;
  public downloadedArtifactPath: string | null = null;
  public installTriggered = false;

  constructor(feedBaseUrl: string, installedVersion: string) {
    super();
    this.feedBaseUrl = feedBaseUrl;
    this.installedVersion = installedVersion;
  }

  public async checkForUpdates(): Promise<any> {
    this.emit('checking-for-update');

    return new Promise((resolve, reject) => {
      http.get(`${this.feedBaseUrl}/latest.json`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const meta = JSON.parse(body);
            if (meta.version !== this.installedVersion) {
              const info = {
                version: meta.version,
                releaseDate: meta.releaseDate,
                releaseNotes: meta.releaseNotes,
                releaseName: meta.releaseName,
              };
              this.emit('update-available', info);
              resolve({ updateInfo: info });
            } else {
              this.emit('update-not-available');
              resolve({ updateInfo: null });
            }
          } catch (e) {
            this.emit('error', e);
            reject(e);
          }
        });
      }).on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });
    });
  }

  public async downloadUpdate(): Promise<any> {
    this.emit('download-progress', { percent: 10, bytesPerSecond: 500000, transferred: 1000000, total: 10000000 });
    this.emit('download-progress', { percent: 50, bytesPerSecond: 500000, transferred: 5000000, total: 10000000 });
    this.emit('download-progress', { percent: 100, bytesPerSecond: 500000, transferred: 10000000, total: 10000000 });
    this.downloadedArtifactPath = 'C:\\Mock\\AgentForge-Setup-0.2.0.exe';
    this.emit('update-downloaded', { version: '0.2.0' });
  }

  public quitAndInstall(): void {
    this.installTriggered = true;
  }
}

describe('Installed Application Update Integration Proof (PR #9)', () => {
  let server: http.Server;
  let serverPort: number;
  const mockReleaseMeta = {
    version: '0.2.0',
    releaseDate: '2026-08-19T00:00:00Z',
    releaseNotes: 'AgentForge v0.2.0 Demo Release with Vietnamese i18n and safe auto-update',
    releaseName: 'v0.2.0-demo',
    sha512: 'abcdef1234567890',
  };

  beforeAll(async () => {
    // Spin up local mock update feed server
    server = http.createServer((req, res) => {
      if (req.url === '/latest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockReleaseMeta));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('1. installed v0.1.0 queries feed, detects v0.2.0, downloads, and awaits Owner install', async () => {
    const feedUrl = `http://127.0.0.1:${serverPort}`;
    const adapter = new ControlledHttpUpdaterAdapter(feedUrl, '0.1.0');

    const updateService = new UpdateService({
      currentVersion: '0.1.0',
      isPackaged: true,
      isCodeSigned: false,
      adapter,
    });

    // Step 1: Initial state
    expect(updateService.getState().state).toBe('IDLE');
    expect(updateService.getState().currentVersion).toBe('0.1.0');

    // Step 2: Check for updates against local server
    const checkResult = await updateService.checkForUpdates();
    expect(checkResult.state).toBe('UPDATE_AVAILABLE');
    expect(checkResult.updateInfo?.version).toBe('0.2.0');
    expect(checkResult.updateInfo?.releaseName).toBe('v0.2.0-demo');

    // Step 3: Explicit Owner download
    const downloadResult = await updateService.downloadUpdate();
    expect(downloadResult.state).toBe('DOWNLOADED');
    expect(downloadResult.progress?.percent).toBe(100);
    expect(downloadResult.canInstall).toBe(true);

    // Step 4: Verify quitAndInstall was NOT called automatically
    expect(adapter.installTriggered).toBe(false);

    // Step 5: Explicit Owner triggers install
    updateService.installAndRestart();
    expect(adapter.installTriggered).toBe(true);
    expect(updateService.getState().state).toBe('INSTALLING');
  });

  it('2. installed v0.2.0 queries feed and correctly identifies it is already up to date', async () => {
    const feedUrl = `http://127.0.0.1:${serverPort}`;
    const adapter = new ControlledHttpUpdaterAdapter(feedUrl, '0.2.0');

    const updateService = new UpdateService({
      currentVersion: '0.2.0',
      isPackaged: true,
      isCodeSigned: false,
      adapter,
    });

    const checkResult = await updateService.checkForUpdates();
    expect(checkResult.state).toBe('NO_UPDATE_AVAILABLE');
    expect(checkResult.updateInfo).toBeNull();
  });
});
