import { app, BrowserWindow } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { defaultDb } from '../core/database/db';
import { Repository } from '../core/database/repositories';
import { EventService } from '../core/services/EventService';
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

    // 2. ChatGPT Manager Resource
    repo.createProviderResource({
      id: 'res-chatgpt-manager',
      provider_id: manualProvider.id,
      model_name: 'ChatGPT Manager (GPT-4o)',
      health_status: 'AVAILABLE',
      capabilities: ['PLANNING', 'REVIEW', 'SECURITY_REVIEW', 'LARGE_CONTEXT'],
      enabled: true,
      total_quota: 100,
      remaining_quota: 85,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 0.9,
      last_health_check: now,
    });

    // 3. Gemini Coder Resource
    repo.createProviderResource({
      id: 'res-gemini-coder',
      provider_id: manualProvider.id,
      model_name: 'Gemini Coder (Gemini 1.5 Pro)',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'LARGE_CONTEXT'],
      enabled: true,
      total_quota: 50,
      remaining_quota: 42,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 0.95,
      last_health_check: now,
    });

    // 4. Claude Reviewer Resource
    repo.createProviderResource({
      id: 'res-claude-reviewer',
      provider_id: manualProvider.id,
      model_name: 'Claude Reviewer (Claude 3.5 Sonnet)',
      health_status: 'AVAILABLE',
      capabilities: ['REVIEW', 'SECURITY_REVIEW', 'CODING'],
      enabled: true,
      total_quota: 1000000,
      remaining_quota: 780000,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 0.85,
      last_health_check: now,
    });

    // 5. Default Agents
    repo.createAgent({
      id: 'agent-primary-manager',
      display_name: 'GPT Manager',
      role: 'PRIMARY_MANAGER',
      provider_resource_id: 'res-chatgpt-manager',
      status: 'ACTIVE',
      current_task_id: null,
      last_seen_at: now,
    });

    repo.createAgent({
      id: 'agent-gemini-coder',
      display_name: 'Gemini Coder #1',
      role: 'CODER',
      provider_resource_id: 'res-gemini-coder',
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
  // 1. Initialize SQLite Database
  const db = defaultDb.init();
  const repo = new Repository(db);
  const eventService = new EventService(repo);

  // 2. Perform Startup Recovery & Migrations
  const recoveryService = new CrashRecoveryService(db, repo, eventService);
  recoveryService.performStartupRecovery();

  // 3. Seed default demo resources if database is empty
  seedDefaultResources(repo);

  // 4. Register Typed IPC Handlers
  registerIpcHandlers();

  // 5. Create Desktop Window
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
