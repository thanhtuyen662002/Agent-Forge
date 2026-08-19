import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { BootstrapService, BootstrapResult } from '../core/services/BootstrapService';
import { registerIpcHandlers } from './ipcHandlers';
import { resolveRendererTarget } from './pathHelper';
import { UpdateService } from '../core/services/UpdateService';
import { ElectronUpdaterAdapter } from './updaterAdapter';

let mainWindow: BrowserWindow | null = null;
let bootstrapInstance: BootstrapResult | null = null;
let updateServiceInstance: UpdateService | null = null;

function createWindow(userDataDir: string): void {
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
    const isDev = !app.isPackaged && url.startsWith('http://localhost:5173');
    const isLocalFile = url.startsWith('file://');
    if (!isDev && !isLocalFile) {
      event.preventDefault();
      console.warn(`[Security] Blocked unauthorized window navigation to: ${url}`);
    }
  });

  // Strict Window Open Guard: Deny popups / new window creation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[Security] Blocked unauthorized window open request to: ${url}`);
    return { action: 'deny' };
  });

  const rendererTarget = resolveRendererTarget({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
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
  bootstrapInstance = BootstrapService.initialize(userDataDir);

  // Initialize UpdateService with packaged/unsigned configuration
  const updateAdapter = app.isPackaged ? new ElectronUpdaterAdapter() : undefined;
  updateServiceInstance = new UpdateService({
    currentVersion: typeof app.getVersion === 'function' ? app.getVersion() : '0.1.0',
    isPackaged: app.isPackaged,
    isCodeSigned: false, // Explicit unsigned desktop foundation
    adapter: updateAdapter,
    repository: bootstrapInstance.repo,
  });

  // Register Typed & Validated IPC Handlers
  registerIpcHandlers(
    bootstrapInstance.repo,
    bootstrapInstance.projectService,
    bootstrapInstance.taskService,
    bootstrapInstance.verificationService,
    bootstrapInstance.emergencyStopService,
    bootstrapInstance.providerRoutingService,
    bootstrapInstance.executionAuthorizationService,
    bootstrapInstance.providerDispatchService,
    updateServiceInstance
  );

  // Create Desktop Window
  createWindow(userDataDir);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(userDataDir);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (bootstrapInstance) {
    try {
      bootstrapInstance.dbEngine.close();
      bootstrapInstance = null;
    } catch (err) {
      console.error('[Shutdown] Error cleanly closing SQLite database engine:', err);
    }
  }
});
