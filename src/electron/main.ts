import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { BootstrapService, BootstrapResult } from '../core/services/BootstrapService';
import { registerIpcHandlers } from './ipcHandlers';
import {
  isAllowedRendererNavigation,
  RendererNavigationPolicyOptions,
  RendererTarget,
  resolveRendererTarget,
} from './pathHelper';
import { UpdateService, shouldCheckForUpdates } from '../core/services/UpdateService';
import { ElectronUpdaterAdapter } from './updaterAdapter';
import { DesktopAutomationService } from '../core/services/DesktopAutomationService';
import { AccountQuotaService } from '../core/services/AccountQuotaService';
import { CodexAccountConnectionService } from '../core/services/CodexAccountConnectionService';
import { CliAccountConnectionService } from '../core/services/CliAccountConnectionService';
import { AgentForgeMcpServer } from './mcpServer';
import { AntigravityCredentialSlots } from '../core/credentials/AntigravityCredentialSlots';
import { WindowsCredentialVault } from '../core/credentials/WindowsCredentialVault';

let mainWindow: BrowserWindow | null = null;
let bootstrapInstance: BootstrapResult | null = null;
let updateServiceInstance: UpdateService | null = null;
let automationInstance: DesktopAutomationService | null = null;
let quotaInstance: AccountQuotaService | null = null;
let signInInstance: CodexAccountConnectionService | null = null;
let mcpInstance: AgentForgeMcpServer | null = null;

function createWindow(
  userDataDir: string,
  rendererTarget: RendererTarget,
  navigationPolicy: RendererNavigationPolicyOptions,
): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#090d16',
    title: 'Agent-Forge — Local AI Engineering Control Plane',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Deterministic Smoke Mode: Record verified renderer readiness
  if (process.env.AGENT_FORGE_SMOKE_MODE === '1') {
    const reportPath = path.join(userDataDir, 'smoke-ready.json');

    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const result = await mainWindow!.webContents.executeJavaScript(`
          new Promise((resolve) => {
            var start = Date.now();
            function check() {
              var root = document.querySelector('#root');
              var count = root ? root.children.length : 0;
              if (count > 0 || (Date.now() - start > 4000)) {
                resolve({
                  location: window.location.href,
                  rootExists: !!root,
                  rootChildCount: count
                });
              } else {
                setTimeout(check, 50);
              }
            }
            check();
          })
        `);

        const report = {
          status: result.rootExists && result.rootChildCount > 0 ? 'READY' : 'FAILED',
          rendererUrl: result.location,
          rootExists: result.rootExists,
          rootChildCount: result.rootChildCount,
          windowTitle: mainWindow ? mainWindow.getTitle() : '',
          isPackaged: app.isPackaged,
          appVersion: app.getVersion(),
          sqliteInitialized: bootstrapInstance !== null,
          updateServiceInitialized: updateServiceInstance !== null,
          timestamp: new Date().toISOString(),
        };

        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
      } catch (err: any) {
        const errorReport = {
          status: 'FAILED',
          error: String(err),
          isPackaged: app.isPackaged,
          sqliteInitialized: bootstrapInstance !== null,
          timestamp: new Date().toISOString(),
        };
        fs.writeFileSync(reportPath, JSON.stringify(errorReport, null, 2), 'utf-8');
      }
    });

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      const failReport = {
        status: 'FAILED',
        errorCode,
        errorDescription,
        validatedURL,
        isPackaged: app.isPackaged,
        sqliteInitialized: bootstrapInstance !== null,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(reportPath, JSON.stringify(failReport, null, 2), 'utf-8');
    });
  }

  // Strict Navigation Guard: Block uncontrolled external navigation
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererNavigation(url, navigationPolicy)) {
      event.preventDefault();
      console.warn(`[Security] Blocked unauthorized window navigation to: ${url}`);
    }
  });

  // Redirects do not necessarily emit will-navigate. Apply the same exact
  // origin/file policy so a trusted page cannot redirect the privileged window
  // to an external or lookalike renderer.
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedRendererNavigation(url, navigationPolicy)) {
      event.preventDefault();
      console.warn(`[Security] Blocked unauthorized window redirect to: ${url}`);
    }
  });

  // Strict Window Open Guard: Deny popups / new window creation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[Security] Blocked unauthorized window open request to: ${url}`);
    return { action: 'deny' };
  });

  if (rendererTarget.type === 'url') {
    mainWindow.loadURL(rendererTarget.target);
  } else {
    mainWindow.loadFile(rendererTarget.target);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const userDataDir = process.env.AGENT_FORGE_DATA_DIR || app.getPath('userData');
  const rendererTarget = resolveRendererTarget({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  });
  const navigationPolicy: RendererNavigationPolicyOptions = {
    isPackaged: app.isPackaged,
    rendererFilePath: rendererTarget.type === 'file' ? rendererTarget.target : undefined,
    devServerUrl: rendererTarget.type === 'url' ? rendererTarget.target : undefined,
  };
  // Antigravity keeps one machine-wide sign-in; each account gets its own slot (#304).
  // A swap interrupted by a crash is restored before anything runs.
  const antigravitySlots = process.platform === 'win32' ? new AntigravityCredentialSlots(new WindowsCredentialVault()) : null;
  try { antigravitySlots?.recover(); } catch { /* the vault is unavailable; runs use the machine-wide sign-in */ }
  bootstrapInstance = BootstrapService.initialize(userDataDir, { antigravitySlots });

  // Initialize UpdateService with packaged/unsigned configuration
  const updateAdapter = app.isPackaged ? new ElectronUpdaterAdapter() : undefined;
  updateServiceInstance = new UpdateService({
    currentVersion: typeof app.getVersion === 'function' ? app.getVersion() : '0.1.0',
    isPackaged: app.isPackaged,
    isCodeSigned: false, // Explicit unsigned desktop foundation
    adapter: updateAdapter,
    repository: bootstrapInstance.repo,
  });

  // Bounded desktop runtime: automated coder execution for RUNNING projects and
  // read-only account quota polling. Both only use existing durable fences.
  automationInstance = new DesktopAutomationService(
    bootstrapInstance.repo,
    bootstrapInstance.eventService,
    bootstrapInstance.providerRegistry,
    {
      worktreeRoot: path.join(userDataDir, 'worktrees'),
      // Up to 10 operations at once; each project's own setting and each agent's slots bound it further (#306).
      maxConcurrentExecutions: 10,
      taskService: bootstrapInstance.taskService,
      verificationService: bootstrapInstance.verificationService,
    },
  );
  quotaInstance = new AccountQuotaService(bootstrapInstance.repo, {
    initializeVerifiedAccounts: true,
    preferencesFile: path.join(userDataDir, 'quota-preferences.json'),
  });
  const quotaForSignIn = quotaInstance;
  const automationForSignIn = automationInstance;
  signInInstance = new CodexAccountConnectionService(bootstrapInstance.repo, {
    // A completed sign-in is verified by an authenticated quota read, which is
    // the only path that may initialize the never-used account's health.
    onSignedIn: async (accountId) => {
      await quotaForSignIn.refreshAccount(accountId);
      await automationForSignIn.tick();
    },
  });

  // Claude Code and Gemini: the CLI's own browser sign-in, then its own check (#242).
  const registryForSignIn = bootstrapInstance.providerRegistry;
  const cliSignIn = new CliAccountConnectionService(bootstrapInstance.repo, {
    // The check proves exactly the binary the adapter will run.
    executableFor: (providerId) => {
      const adapter = registryForSignIn.get(providerId) as { getExecutablePath?: () => string } | undefined;
      return adapter?.getExecutablePath?.() ?? null;
    },
    onVerified: async () => { await automationForSignIn.tick(); },
    antigravitySlots,
  });

  // Local MCP server for external AIs (#289): off until the owner enables it.
  mcpInstance = new AgentForgeMcpServer({
    settingsFile: path.join(userDataDir, 'mcp-settings.json'),
    version: typeof app.getVersion === 'function' ? app.getVersion() : '0.1.0',
  });

  // Register Typed & Validated IPC Handlers
  const ipcRegistry = registerIpcHandlers(
    bootstrapInstance.repo,
    bootstrapInstance.projectService,
    bootstrapInstance.taskService,
    bootstrapInstance.verificationService,
    bootstrapInstance.emergencyStopService,
    bootstrapInstance.providerRoutingService,
    bootstrapInstance.executionAuthorizationService,
    bootstrapInstance.providerDispatchService,
    updateServiceInstance,
    undefined,
    navigationPolicy,
    { automation: automationInstance, quota: quotaInstance, signIn: signInInstance, cliSignIn, mcp: mcpInstance },
  );
  mcpInstance.attach(ipcRegistry);
  void mcpInstance.start();
  automationInstance.start();
  quotaInstance.start();
  scheduleUpdateChecks();
  void quotaInstance.refreshAll();

  // Create Desktop Window
  createWindow(userDataDir, rendererTarget, navigationPolicy);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(userDataDir, rendererTarget, navigationPolicy);
    }
  });
});

/**
 * Dev-channel updates (#298): a check shortly after start and every 4 hours.
 * An update already found or downloaded is never re-checked away; installing
 * stays the owner's one click.
 */
function scheduleUpdateChecks(): void {
  if (!app.isPackaged) return;
  const check = () => {
    const service = updateServiceInstance;
    if (!service || !shouldCheckForUpdates(service.getState().state)) return;
    void service.checkForUpdates().catch(() => undefined);
  };
  setTimeout(check, 30_000).unref?.();
  setInterval(check, 4 * 60 * 60_000).unref?.();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Stop new dispatch and polling first; in-flight executions keep their
  // durable fences and are reconciled by startup recovery if interrupted.
  automationInstance?.stop();
  quotaInstance?.stop();
  signInInstance?.dispose();
  void mcpInstance?.stop();
  if (bootstrapInstance) {
    try {
      bootstrapInstance.dbEngine.close();
      bootstrapInstance = null;
    } catch (err) {
      console.error('[Shutdown] Error cleanly closing SQLite database engine:', err);
    }
  }
});
