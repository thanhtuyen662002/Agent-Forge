import { app, BrowserWindow } from 'electron';
import path from 'path';
import { BootstrapService } from '../core/services/BootstrapService';
import { registerIpcHandlers } from './ipcHandlers';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  const bootstrap = BootstrapService.initialize(userDataDir);

  // Register Typed & Validated IPC Handlers
  registerIpcHandlers(
    bootstrap.repo,
    bootstrap.projectService,
    bootstrap.taskService,
    bootstrap.verificationService,
    bootstrap.emergencyStopService
  );

  // Create Desktop Window
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
