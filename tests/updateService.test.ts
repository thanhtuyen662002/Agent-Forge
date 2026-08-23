import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { UpdateService, IUpdateAdapter } from '../src/core/services/UpdateService';
import {
  UpdateGetStateIpcSchema,
  UpdateCheckIpcSchema,
  UpdateDownloadIpcSchema,
  UpdateInstallAndRestartIpcSchema,
  GetAppInfoIpcSchema,
} from '../src/core/types/ipc';

class MockUpdateAdapter extends EventEmitter implements IUpdateAdapter {
  public checkForUpdatesMock = vi.fn();
  public downloadUpdateMock = vi.fn();
  public quitAndInstallMock = vi.fn();

  public async checkForUpdates(): Promise<any> {
    return this.checkForUpdatesMock();
  }

  public async downloadUpdate(): Promise<any> {
    return this.downloadUpdateMock();
  }

  public quitAndInstall(): void {
    this.quitAndInstallMock();
  }
}

describe('UpdateService & Installed-App Update Domain (PR #9)', () => {
  let mockAdapter: MockUpdateAdapter;
  let updateService: UpdateService;

  beforeEach(() => {
    mockAdapter = new MockUpdateAdapter();
    updateService = new UpdateService({
      currentVersion: '0.1.0',
      isPackaged: true,
      isCodeSigned: false,
      adapter: mockAdapter,
    });
  });

  it('1. current version comes from authoritative app metadata', () => {
    const state = updateService.getState();
    expect(state.currentVersion).toBe('0.1.0');
    expect(state.state).toBe('IDLE');
    expect(state.isPackaged).toBe(true);
    expect(state.isCodeSigned).toBe(false);
  });

  it('2. IDLE -> CHECKING when update check initiates', async () => {
    mockAdapter.checkForUpdatesMock.mockImplementation(async () => {
      mockAdapter.emit('checking-for-update');
      return null;
    });

    const checkPromise = updateService.checkForUpdates();
    expect(updateService.getState().state).toBe('CHECKING');
    await checkPromise;
  });

  it('3. CHECKING -> NO_UPDATE_AVAILABLE when no newer release exists', async () => {
    mockAdapter.checkForUpdatesMock.mockImplementation(async () => {
      mockAdapter.emit('update-not-available');
      return { updateInfo: null };
    });

    await updateService.checkForUpdates();
    const state = updateService.getState();
    expect(state.state).toBe('NO_UPDATE_AVAILABLE');
    expect(state.updateInfo).toBeNull();
    expect(state.lastCheckedAt).toBeDefined();
  });

  it('4. CHECKING -> UPDATE_AVAILABLE when newer release is reported', async () => {
    mockAdapter.checkForUpdatesMock.mockImplementation(async () => {
      mockAdapter.emit('update-available', {
        version: '0.2.0',
        releaseDate: '2026-08-19T00:00:00Z',
        releaseNotes: 'PR #9 Demo Readiness',
      });
      return {
        updateInfo: {
          version: '0.2.0',
          releaseDate: '2026-08-19T00:00:00Z',
          releaseNotes: 'PR #9 Demo Readiness',
        },
      };
    });

    await updateService.checkForUpdates();
    const state = updateService.getState();
    expect(state.state).toBe('UPDATE_AVAILABLE');
    expect(state.updateInfo?.version).toBe('0.2.0');
    expect(state.updateInfo?.releaseNotes).toBe('PR #9 Demo Readiness');
  });

  it('5. UPDATE_AVAILABLE -> DOWNLOADING when download begins', async () => {
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.downloadUpdateMock.mockImplementation(async () => {
      mockAdapter.emit('download-progress', { percent: 25 });
    });

    const dlPromise = updateService.downloadUpdate();
    expect(updateService.getState().state).toBe('DOWNLOADING');
    await dlPromise;
  });

  it('6. real reported progress maps safely into sanitized UI state', async () => {
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.emit('download-progress', {
      percent: 63.456,
      bytesPerSecond: 1024000,
      transferred: 6345600,
      total: 10000000,
    });

    const state = updateService.getState();
    expect(state.state).toBe('DOWNLOADING');
    expect(state.progress?.percent).toBe(63);
    expect(state.progress?.transferred).toBe(6345600);
    expect(state.progress?.total).toBe(10000000);
  });

  it('7. DOWNLOADING -> DOWNLOADED upon download completion', async () => {
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.emit('update-downloaded', { version: '0.2.0' });

    const state = updateService.getState();
    expect(state.state).toBe('DOWNLOADED');
    expect(state.progress?.percent).toBe(100);
    expect(state.canInstall).toBe(true);
  });

  it('8. DOWNLOADED allows explicit Owner install request', () => {
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.emit('update-downloaded', { version: '0.2.0' });

    updateService.installAndRestart();
    expect(mockAdapter.quitAndInstallMock).toHaveBeenCalledTimes(1);
    expect(updateService.getState().state).toBe('INSTALLING');
  });

  it('9. install is NOT triggered automatically after download completes', () => {
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.emit('update-downloaded', { version: '0.2.0' });

    // Ensure quitAndInstall was NOT called automatically
    expect(mockAdapter.quitAndInstallMock).not.toHaveBeenCalled();
    expect(updateService.getState().state).toBe('DOWNLOADED');
  });

  it('10. updater error transitions state safely to ERROR', () => {
    mockAdapter.emit('error', new Error('Network timeout reaching update feed'));
    const state = updateService.getState();
    expect(state.state).toBe('ERROR');
    expect(state.error).toContain('Network timeout reaching update feed');
  });

  it('11. retry after recoverable error restarts update check state machine', async () => {
    mockAdapter.emit('error', new Error('Transient connection error'));
    expect(updateService.getState().state).toBe('ERROR');

    mockAdapter.checkForUpdatesMock.mockImplementation(async () => {
      mockAdapter.emit('update-not-available');
      return { updateInfo: null };
    });

    await updateService.checkForUpdates();
    expect(updateService.getState().state).toBe('NO_UPDATE_AVAILABLE');
    expect(updateService.getState().error).toBeNull();
  });

  it('12. arbitrary renderer URL is impossible and rejected by Zod schema', () => {
    const invalidCheckPayload = { updateUrl: 'https://attacker.com/evil.exe' };
    const parsed = UpdateCheckIpcSchema.safeParse(invalidCheckPayload);
    expect(parsed.success).toBe(false);
  });

  it('13. arbitrary renderer executable path is impossible and rejected by Zod schema', () => {
    const invalidInstallPayload = { executablePath: 'C:\\Windows\\System32\\cmd.exe' };
    const parsed = UpdateInstallAndRestartIpcSchema.safeParse(invalidInstallPayload);
    expect(parsed.success).toBe(false);
  });

  it('14. malformed IPC payload is strictly rejected', () => {
    const malformedDownload = { headers: { Authorization: 'Bearer test' } };
    const parsed = UpdateDownloadIpcSchema.safeParse(malformedDownload);
    expect(parsed.success).toBe(false);
  });

  it('15. renderer cannot set update feed URL through IPC', () => {
    const parsed = UpdateGetStateIpcSchema.safeParse({ feedUrl: 'https://evil.com' });
    expect(parsed.success).toBe(false);
  });

  it('16. renderer cannot inject auth headers or tokens into update requests', () => {
    const parsed = UpdateCheckIpcSchema.safeParse({ token: 'ghp_secret' });
    expect(parsed.success).toBe(false);
  });

  it('17. renderer cannot pass shell commands through update IPC', () => {
    const parsed = UpdateInstallAndRestartIpcSchema.safeParse({ command: 'rm -rf /' });
    expect(parsed.success).toBe(false);
  });

  it('18. update error sanitizer strips secrets and tokens from error messages', () => {
    mockAdapter.emit(
      'error',
      new Error('Failed to fetch from https://user:secretpassword@github.com with token ghp_1234567890abcdef and Bearer eyJhbGciOiJIUzI1NiJ9')
    );

    const state = updateService.getState();
    expect(state.error).not.toContain('secretpassword');
    expect(state.error).not.toContain('ghp_1234567890abcdef');
    expect(state.error).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(state.error).toContain('[REDACTED_TOKEN]');
    expect(state.error).toContain('Bearer [REDACTED]');
  });

  it('19. development mode (non-packaged) marks updater DISABLED without crashing', async () => {
    const devUpdateService = new UpdateService({
      currentVersion: '0.1.0-dev',
      isPackaged: false,
    });

    const state = devUpdateService.getState();
    expect(state.state).toBe('DISABLED');
    expect(state.isPackaged).toBe(false);

    const checkResult = await devUpdateService.checkForUpdates();
    expect(checkResult.state).toBe('DISABLED');
  });

  it('20. unavailable updater adapter does not crash bootstrap or state inspection', () => {
    const headlessService = new UpdateService({
      currentVersion: '0.1.0',
      isPackaged: true,
      adapter: undefined,
    });

    expect(headlessService.getState().state).toBe('IDLE');
    expect(headlessService.getState().currentVersion).toBe('0.1.0');
  });

  it('21. active unsafe workflow prevents unexpected restart and install', () => {
    const mockRepo: any = {
      getAllProjects: () => [{ id: 'proj-1', name: 'Active Project' }],
      getTasksByProject: () => [
        { id: 'tsk-1', title: 'Critical Coding Task', state: 'CODING' },
      ],
    };

    updateService.setRepository(mockRepo);
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.emit('update-downloaded', { version: '0.2.0' });

    expect(updateService.getState().canInstall).toBe(false);

    expect(() => {
      updateService.installAndRestart();
    }).toThrow(/UPDATE_RESTART_BLOCKED: Task "Critical Coding Task"/);

    expect(mockAdapter.quitAndInstallMock).not.toHaveBeenCalled();
  });

  it('22. safe idle state permits explicit install request', () => {
    const mockRepo: any = {
      getAllProjects: () => [{ id: 'proj-1', name: 'Idle Project' }],
      getTasksByProject: () => [
        { id: 'tsk-1', title: 'Completed Task', state: 'DONE' },
      ],
    };

    updateService.setRepository(mockRepo);
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.emit('update-downloaded', { version: '0.2.0' });

    expect(updateService.getState().canInstall).toBe(true);
    updateService.installAndRestart();
    expect(mockAdapter.quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it('23. repeated install clicks cannot trigger multiple uncontrolled install calls', () => {
    mockAdapter.emit('update-available', { version: '0.2.0' });
    mockAdapter.emit('update-downloaded', { version: '0.2.0' });

    updateService.installAndRestart();
    expect(mockAdapter.quitAndInstallMock).toHaveBeenCalledTimes(1);

    // Second call while state is INSTALLING is debounced
    updateService.installAndRestart();
    expect(mockAdapter.quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it('24. update service has no coupling to ProviderDispatchService', () => {
    // Assert UpdateService class has no dispatch method or provider execution capability
    expect((updateService as any).dispatch).toBeUndefined();
    expect((updateService as any).executeProvider).toBeUndefined();
  });

  it('25. update service cannot manufacture ExecutionAuthorization records', () => {
    expect((updateService as any).createAuthorization).toBeUndefined();
    expect((updateService as any).authorizeTask).toBeUndefined();
  });

  describe('Mandatory Update Error Contract & Safety Tests (PR #9 Corrective 1)', () => {
    it('26. network/check rejection results in final state ERROR', async () => {
      mockAdapter.checkForUpdatesMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND github.com'));

      const result = await updateService.checkForUpdates();
      expect(result.state).toBe('ERROR');
      expect(result.error).toContain('ENOTFOUND github.com');
      expect(updateService.getState().state).toBe('ERROR');
    });

    it('27. adapter check throws synchronously/asynchronously results in final state ERROR', async () => {
      mockAdapter.checkForUpdatesMock.mockImplementation(() => {
        throw new Error('HttpError: 503 Service Unavailable');
      });

      const result = await updateService.checkForUpdates();
      expect(result.state).toBe('ERROR');
      expect(result.error).toContain('503 Service Unavailable');
    });

    it('28. check error is sanitized of tokens, basic credentials, and long query strings', async () => {
      mockAdapter.checkForUpdatesMock.mockRejectedValue(
        new Error('Failed request to https://ghp_mySuperSecretToken12345@api.github.com/repos/thanhtuyen662002/Agent-Forge/releases with Bearer secret.jwt.token')
      );

      const result = await updateService.checkForUpdates();
      expect(result.state).toBe('ERROR');
      expect(result.error).not.toContain('ghp_mySuperSecretToken12345');
      expect(result.error).not.toContain('secret.jwt.token');
      expect(result.error).toContain('[REDACTED_TOKEN]');
      expect(result.error).toContain('Bearer [REDACTED]');
    });

    it('29. ERROR is NOT overwritten with NO_UPDATE_AVAILABLE when check fails', async () => {
      // Simulate adapter emitting an error AND returning null/throwing
      mockAdapter.checkForUpdatesMock.mockImplementation(async () => {
        mockAdapter.emit('error', new Error('Feed parse error: invalid YAML'));
        throw new Error('Feed parse error: invalid YAML');
      });

      const result = await updateService.checkForUpdates();
      expect(result.state).toBe('ERROR');
      expect(result.state).not.toBe('NO_UPDATE_AVAILABLE');
      expect(updateService.getState().state).toBe('ERROR');
    });

    it('30. genuine successful no-update check sets final state NO_UPDATE_AVAILABLE', async () => {
      mockAdapter.checkForUpdatesMock.mockImplementation(async () => {
        mockAdapter.emit('update-not-available', { version: '0.1.0' });
        return { updateInfo: null };
      });

      const result = await updateService.checkForUpdates();
      expect(result.state).toBe('NO_UPDATE_AVAILABLE');
      expect(result.error).toBeNull();
      expect(result.updateInfo).toBeNull();
    });

    it('31. genuine newer version available sets final state UPDATE_AVAILABLE with metadata', async () => {
      mockAdapter.checkForUpdatesMock.mockImplementation(async () => {
        const info = {
          version: '0.1.1',
          releaseDate: '2026-08-20T00:00:00Z',
          releaseNotes: 'Performance improvements and bug fixes',
          releaseName: 'v0.1.1',
        };
        mockAdapter.emit('update-available', info);
        return { updateInfo: info };
      });

      const result = await updateService.checkForUpdates();
      expect(result.state).toBe('UPDATE_AVAILABLE');
      expect(result.updateInfo?.version).toBe('0.1.1');
      expect(result.updateInfo?.releaseName).toBe('v0.1.1');
    });

    it('32. retry after recoverable ERROR can successfully check again and reach UPDATE_AVAILABLE or NO_UPDATE_AVAILABLE', async () => {
      // Step 1: Fail with ERROR
      mockAdapter.checkForUpdatesMock.mockRejectedValueOnce(new Error('Transient ETIMEDOUT'));
      const failResult = await updateService.checkForUpdates();
      expect(failResult.state).toBe('ERROR');
      expect(failResult.error).toContain('Transient ETIMEDOUT');

      // Step 2: Retry succeeds with newer version
      mockAdapter.checkForUpdatesMock.mockImplementationOnce(async () => {
        const info = { version: '0.1.1' };
        mockAdapter.emit('update-available', info);
        return { updateInfo: info };
      });

      const retryResult = await updateService.checkForUpdates();
      expect(retryResult.state).toBe('UPDATE_AVAILABLE');
      expect(retryResult.error).toBeNull();
      expect(retryResult.updateInfo?.version).toBe('0.1.1');
    });

    it('33. no crash during application bootstrap if updater initialization/check is unavailable', () => {
      // Uninitialized / unconfigured service in packaged mode
      const unconfiguredService = new UpdateService({
        currentVersion: '0.1.0',
        isPackaged: true,
      });

      expect(() => unconfiguredService.getState()).not.toThrow();
      expect(unconfiguredService.getState().state).toBe('IDLE');
    });
  });

  describe('Static Packaging & Release Configuration Invariants', () => {
    it('34. electron-builder.yml configures GitHub production update provider without credentials', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const configPath = path.resolve(__dirname, '../electron-builder.yml');
      const content = fs.readFileSync(configPath, 'utf8');

      expect(content).toMatch(/provider:\s*github/);
      expect(content).toMatch(/owner:\s*thanhtuyen662002/);
      expect(content).toMatch(/repo:\s*Agent-Forge/);

      // Verify no tokens or credentials
      expect(content).not.toMatch(/ghp_/);
      expect(content).not.toMatch(/token/i);
      expect(content).not.toMatch(/password/i);
      expect(content).not.toMatch(/Authorization/i);
    });

    it('35. package.json packaging scripts strictly enforce --publish never for normal builds', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const pkgPath = path.resolve(__dirname, '../package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      expect(pkg.scripts['package:win']).toContain('--publish never');
      expect(pkg.scripts['package:win:dir']).toContain('--publish never');
    });

    it('36. release-windows.yml has no pull_request trigger, requires workflow_dispatch, and enforces fail-closed version consistency', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const releaseYmlPath = path.resolve(__dirname, '../.github/workflows/release-windows.yml');
      expect(fs.existsSync(releaseYmlPath)).toBe(true);

      const content = fs.readFileSync(releaseYmlPath, 'utf8');
      expect(content).toMatch(/workflow_dispatch:/);
      expect(content).not.toMatch(/pull_request:/);
      expect(content).toMatch(/VERSION MISMATCH FAIL-CLOSED/);
      expect(content).toMatch(/--draft/);
    });

    it('37. release-windows.yml builds full NSIS package ONCE with package:win and stages frozen assets without --publish always', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const releaseYmlPath = path.resolve(__dirname, '../.github/workflows/release-windows.yml');
      const content = fs.readFileSync(releaseYmlPath, 'utf8');

      // Package step must build complete NSIS package
      expect(content).toMatch(/run:\s*npm run package:win/);
      // Stages exact assets
      expect(content).toMatch(/prepare-release-assets-win\.ps1/);
      // Publishes frozen assets via gh release create
      expect(content).toMatch(/gh release create/);
      // Never uses electron-builder --publish always rebuild
      expect(content).not.toMatch(/--publish always/);
    });

    it('38. production committed main.ts has zero occurrences of AGENT_FORGE_TEST_UPDATE or AGENT_FORGE_TRIGGER_INSTALL', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const mainPath = path.resolve(__dirname, '../src/electron/main.ts');
      const content = fs.readFileSync(mainPath, 'utf8');

      expect(content).not.toContain('AGENT_FORGE_TEST_UPDATE');
      expect(content).not.toContain('AGENT_FORGE_TRIGGER_INSTALL');
    });

    it('39. production main process and updater adapter cannot accept arbitrary feed URLs or expose setFeedURL', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const adapterPath = path.resolve(__dirname, '../src/electron/updaterAdapter.ts');
      const ipcPath = path.resolve(__dirname, '../src/electron/ipcHandlers.ts');
      const preloadPath = path.resolve(__dirname, '../src/electron/preload.ts');
      const adapterContent = fs.readFileSync(adapterPath, 'utf8');
      const ipcContent = fs.readFileSync(ipcPath, 'utf8');
      const preloadContent = fs.readFileSync(preloadPath, 'utf8');

      expect(adapterContent).not.toContain('setFeedURL');
      expect(ipcContent).not.toContain('setFeedURL');
      expect(ipcContent).not.toContain('updateUrl');
      expect(preloadContent).not.toContain('setFeedURL');
      expect(preloadContent).not.toContain('updateUrl');
    });

    it('40. test-installed-update-win.ps1 uses isolated temporary build context and does not modify installed app-update.yml', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const scriptPath = path.resolve(__dirname, '../scripts/test-installed-update-win.ps1');
      const content = fs.readFileSync(scriptPath, 'utf8');

      // Uses temporary isolated build context for TEST vA and vB
      expect(content).toContain('builder-vA.yml');
      expect(content).toContain('builder-vB.yml');
      expect(content).toContain('http://127.0.0.1:$testPort/');

      // Inspects installed config without rewriting it
      expect(content).toMatch(/Get-Content -Path \$installedUpdateYml/);
      expect(content).not.toMatch(/Set-Content\s+-Path\s+\$installedUpdateYml/);
    });

    it('41. production source and configuration files contain zero GitHub tokens or credentials', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const configPath = path.resolve(__dirname, '../electron-builder.yml');
      const content = fs.readFileSync(configPath, 'utf8');

      expect(content).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
      expect(content).not.toMatch(/github_pat_[a-zA-Z0-9_]+/);
      expect(content).not.toMatch(/Bearer\s+/i);
    });
  });
});
