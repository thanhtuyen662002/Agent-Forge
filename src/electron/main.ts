import { app, BrowserWindow } from 'electron';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { defaultDb } from '../core/database/db';
import { defaultArtifactStore } from '../core/services/ArtifactStore';
import { Repository } from '../core/database/repositories';
import { EventService } from '../core/services/EventService';
import { ProjectService } from '../core/services/ProjectService';
import { TaskService } from '../core/services/TaskService';
import { VerificationService } from '../core/services/VerificationService';
import { EmergencyStopService } from '../core/services/EmergencyStopService';
import { CrashRecoveryService } from '../core/services/CrashRecoveryService';
import { registerIpcHandlers } from './ipcHandlers';

let mainWindow: BrowserWindow | null = null;

function seedDefaultResources(repo: Repository): void {
  const providers = repo.getAllProviders();
  if (providers.length === 0) {
    const now = new Date().toISOString();

    // 1. Manual Bridge Provider
    const manualProvider = {
      id: 'prov-manual-bridge',
      name: 'Owner Manual Bridge',
      adapter_type: 'MANUAL_BRIDGE' as const,
      enabled: true,
      created_at: now,
    };
    repo.createProvider(manualProvider);

    // 2. Initial Provider Resources with UNKNOWN status & unmeasured quota (Truth in Observability)
    repo.createProviderResource({
      id: 'res-chatgpt-manager',
      provider_id: manualProvider.id,
      model_name: 'ChatGPT Manager',
      health_status: 'UNKNOWN',
      capabilities: ['PLANNING', 'REVIEW', 'SECURITY_REVIEW', 'LARGE_CONTEXT'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0.0,
      last_health_check: null,
    });

    repo.createProviderResource({
      id: 'res-gemini-coder',
      provider_id: manualProvider.id,
      model_name: 'Gemini Coder',
      health_status: 'UNKNOWN',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'LARGE_CONTEXT'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0.0,
      last_health_check: null,
    });

    repo.createProviderResource({
      id: 'res-claude-reviewer',
      provider_id: manualProvider.id,
      model_name: 'Claude Reviewer',
      health_status: 'UNKNOWN',
      capabilities: ['REVIEW', 'SECURITY_REVIEW', 'CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0.0,
      last_health_check: null,
    });

    // 3. Default Agents
    repo.createAgent({
      id: 'agent-primary-manager',
      display_name: 'ChatGPT Manager (Manual)',
      role: 'PRIMARY_MANAGER',
      provider_resource_id: 'res-chatgpt-manager',
      status: 'ACTIVE',
      current_task_id: null,
      last_seen_at: now,
    });

    repo.createAgent({
      id: 'agent-gemini-coder',
      display_name: 'Gemini Coder (Manual)',
      role: 'CODER',
      provider_resource_id: 'res-gemini-coder',
      status: 'IDLE',
      current_task_id: null,
      last_seen_at: now,
    });

    repo.createAgent({
      id: 'agent-claude-reviewer',
      display_name: 'Claude Reviewer (Manual)',
      role: 'REVIEWER',
      provider_resource_id: 'res-claude-reviewer',
      status: 'IDLE',
      current_task_id: null,
      last_seen_at: now,
    });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
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

  // Block opening unvetted new browser windows / popups
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  // Prevent navigation away from the app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://localhost:5173') || url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
    }
  });

  // Load Vite dev server during development, otherwise production index.html
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // 1. Resolve User Data Path & Inject into DB and ArtifactStore
  const userDataDir = app.getPath('userData');
  const dbDir = path.join(userDataDir, 'database');
  const artifactsDir = path.join(userDataDir, 'artifacts');

  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

  defaultDb.setDatabasePath(path.join(dbDir, 'agent-forge.db'));
  defaultArtifactStore.setBaseDir(artifactsDir);

  // 2. Initialize SQLite Database
  const db = defaultDb.init();
  const repo = new Repository(db);
  const eventService = new EventService(repo);

  // 3. Perform Startup Recovery & Migrations
  const recoveryService = new CrashRecoveryService(db, repo, eventService);
  recoveryService.performStartupRecovery();

  // 4. Seed default resources if database is empty
  seedDefaultResources(repo);

  // 5. Initialize Application Core Services
  const projectService = new ProjectService(repo, eventService);
  const verificationService = new VerificationService(repo, defaultArtifactStore);
  const taskService = new TaskService(repo, eventService, verificationService, defaultArtifactStore);
  const emergencyStopService = new EmergencyStopService(repo, eventService);

  // 6. Register Typed & Validated IPC Handlers
  registerIpcHandlers(repo, projectService, taskService, verificationService, emergencyStopService);

  // 7. Create Desktop Window
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    defaultDb.close();
    app.quit();
  }
});
