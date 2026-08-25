import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { BootstrapService } from '../src/core/services/BootstrapService';
import { RepositorySelectionService } from '../src/core/services/RepositorySelectionService';

describe('Bootstrap Smoke & Fresh Database Startup', () => {
  let tmpUserDataDir: string;
  let tmpGitDir: string;

  beforeEach(() => {
    tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-bootstrap-data-'));
    tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-bootstrap-git-'));

    execSync('git init', { cwd: tmpGitDir });
    execSync('git config user.name "Bootstrap Agent"', { cwd: tmpGitDir });
    execSync('git config user.email "agent@agentforge.local"', { cwd: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'README.md'), '# Bootstrap Repo\n', 'utf8');
    execSync('git add README.md', { cwd: tmpGitDir });
    execSync('git commit -m "initial commit"', { cwd: tmpGitDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
      fs.rmSync(tmpGitDir, { recursive: true, force: true });
    } catch {}
    RepositorySelectionService.clearTokens();
  });

  it('should cleanly perform fresh installation, apply all migrations, seed default resources with UNKNOWN health and null quota without constraint errors', () => {
    // Initialize fresh application via composition root BootstrapService
    const bootstrap = BootstrapService.initialize(tmpUserDataDir);

    // Assert all default providers seeded
    const providers = bootstrap.repo.getAllProviders();
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe('prov-manual-bridge');

    // Assert all provider resources seeded with truthful UNKNOWN semantics
    const resources = bootstrap.repo.getAllProviderResources();
    expect(resources.length).toBe(2);

    const chatgpt = resources.find((r) => r.id === 'res-chatgpt-manager')!;
    expect(chatgpt).toBeDefined();
    expect(chatgpt.health_status).toBe('UNKNOWN');
    expect(chatgpt.total_quota).toBeNull();
    expect(chatgpt.remaining_quota).toBeNull();
    expect(chatgpt.last_health_check).toBeNull();
    expect(chatgpt.quota_source).toBe('UNKNOWN');

    const gemini = resources.find((r) => r.id === 'res-gemini-coder')!;
    expect(gemini).toBeDefined();
    expect(gemini.health_status).toBe('UNKNOWN');
    expect(gemini.total_quota).toBeNull();
    expect(gemini.remaining_quota).toBeNull();
    expect(gemini.last_health_check).toBeNull();

    // Assert default agents seeded
    const agents = bootstrap.repo.getAllAgents();
    expect(agents.length).toBe(2);

    // Assert provider registry initialized with registered adapters (Antigravity is MANUAL_BRIDGE_ONLY)
    expect(bootstrap.providerRegistry).toBeDefined();
    expect(bootstrap.providerRegistry.size).toBe(3);
    expect(bootstrap.providerRegistry.has('prov-manual-bridge')).toBe(true);
    expect(bootstrap.providerRegistry.has('prov-codex-cli')).toBe(true);
    expect(bootstrap.providerRegistry.has('prov-gemini-cli')).toBe(true);
    expect(bootstrap.providerRegistry.has('prov-antigravity-cli')).toBe(false);
    expect(bootstrap.providerRoutingService).toBeDefined();
    expect(bootstrap.providerDispatchService).toBeDefined();
    expect(bootstrap.executionAuthorizationService).toBeDefined();

    // Create a project through trusted native selection token flow
    const token = RepositorySelectionService.issueToken(tmpGitDir);
    const consumeRes = RepositorySelectionService.consumeToken(token.selectionId);
    expect(consumeRes.success).toBe(true);

    const project = bootstrap.projectService.createProject(
      'Fresh Bootstrap Project',
      'Testing end-to-end bootstrap',
      consumeRes.canonicalPath!
    );
    expect(project.id).toBeDefined();
    expect(project.status).toBe('DRAFT');

    // Create a task through trusted TaskService.createTask
    const task = bootstrap.taskService.createTask({
      projectId: project.id,
      title: 'Bootstrap Task',
      description: 'Validate fresh task creation',
      priority: 'HIGH',
      risk: 'LOW',
      acceptanceCriteria: ['Task entity valid in SQLite'],
    });

    expect(task.id).toBeDefined();
    expect(task.state).toBe('PLANNED');
    expect(task.revision_count).toBe(0);
    expect(task.max_revisions).toBe(3);
    expect(task.assigned_agent_id).toBeNull();
    expect(task.progress_cache_percent).toBe(0);

    const persistedTask = bootstrap.repo.getTask(task.id)!;
    expect(persistedTask.title).toBe('Bootstrap Task');
    expect(persistedTask.state).toBe('PLANNED');

    // Clean database shutdown
    expect(bootstrap.dbEngine).toBeDefined();
    bootstrap.dbEngine.close();
  });
});
