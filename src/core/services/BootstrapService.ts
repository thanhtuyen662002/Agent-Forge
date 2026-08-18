import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DatabaseEngine } from '../database/db';
import { ArtifactStore } from './ArtifactStore';
import { MigrationRunner } from '../database/migrations';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { CrashRecoveryService } from './CrashRecoveryService';
import { ProjectService } from './ProjectService';
import { TaskService } from './TaskService';
import { VerificationService } from './VerificationService';
import { EmergencyStopService } from './EmergencyStopService';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { ManualBridgeAdapter } from '../adapters/ManualBridgeAdapter';
import { CodexCliAdapter } from '../adapters/CodexCliAdapter';

export interface BootstrapResult {
  db: Database.Database;
  dbEngine: DatabaseEngine;
  repo: Repository;
  artifactStore: ArtifactStore;
  eventService: EventService;
  projectService: ProjectService;
  taskService: TaskService;
  verificationService: VerificationService;
  emergencyStopService: EmergencyStopService;
  providerRegistry: ProviderRegistry;
}

export class BootstrapService {
  public static seedDefaultResources(repo: Repository): void {
    const now = new Date().toISOString();

    // 1. Manual Bridge Provider (idempotent check by ID)
    if (!repo.getProvider('prov-manual-bridge')) {
      repo.createProvider({
        id: 'prov-manual-bridge',
        name: 'Owner Manual Bridge',
        adapter_type: 'MANUAL_BRIDGE' as const,
        enabled: true,
        created_at: now,
      });
    }

    // 2. Initial Provider Resources with UNKNOWN status & unmeasured quota (Truth in Observability)
    if (!repo.getProviderResource('res-chatgpt-manager')) {
      repo.createProviderResource({
        id: 'res-chatgpt-manager',
        provider_id: 'prov-manual-bridge',
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
    }

    if (!repo.getProviderResource('res-gemini-coder')) {
      repo.createProviderResource({
        id: 'res-gemini-coder',
        provider_id: 'prov-manual-bridge',
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
    }

    // 3. Initial Agents
    if (!repo.getAgent('agent-primary-manager')) {
      repo.createAgent({
        id: 'agent-primary-manager',
        display_name: 'ChatGPT Manager (Manual Bridge)',
        role: 'PRIMARY_MANAGER',
        provider_resource_id: 'res-chatgpt-manager',
        status: 'ACTIVE',
        current_task_id: null,
        last_seen_at: now,
      });
    }

    if (!repo.getAgent('agent-gemini-coder')) {
      repo.createAgent({
        id: 'agent-gemini-coder',
        display_name: 'Gemini Coder (Manual Bridge)',
        role: 'CODER',
        provider_resource_id: 'res-gemini-coder',
        status: 'IDLE',
        current_task_id: null,
        last_seen_at: now,
      });
    }
  }

  public static initialize(userDataDir: string): BootstrapResult {
    const dbDir = path.join(userDataDir, 'database');
    const artifactsDir = path.join(userDataDir, 'artifacts');

    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

    const dbPath = path.join(dbDir, 'agent-forge.db');
    const dbEngine = new DatabaseEngine(dbPath);
    const db = dbEngine.init();

    // 1. Run migrations
    MigrationRunner.run(db);

    const repo = new Repository(db);
    const eventService = new EventService(repo);
    const artifactStore = new ArtifactStore(artifactsDir);

    // 2. Perform crash recovery
    const recoveryService = new CrashRecoveryService(db, repo, eventService);
    recoveryService.performStartupRecovery();

    // 3. Seed default resources
    this.seedDefaultResources(repo);

    // 4. Construct application domain services
    const projectService = new ProjectService(repo, eventService);
    const verificationService = new VerificationService(repo, artifactStore);
    const taskService = new TaskService(repo, eventService, verificationService, artifactStore);
    const emergencyStopService = new EmergencyStopService(repo, eventService);

    // 5. Initialize Provider Registry with supported adapters
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new ManualBridgeAdapter());
    // Codex CLI registered as unverified on this host (contractVerified=false); fails closed on execute
    providerRegistry.register(new CodexCliAdapter({ repo, artifactStore, contractVerified: false }));

    return {
      db,
      dbEngine,
      repo,
      artifactStore,
      eventService,
      projectService,
      taskService,
      verificationService,
      emergencyStopService,
      providerRegistry,
    };
  }
}
