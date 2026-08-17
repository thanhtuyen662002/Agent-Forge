import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { Project, Task } from '../src/core/types/domain';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('Verification Commands Fail-Closed Configuration', () => {
  let db: Database.Database;
  let repo: Repository;
  let artifactStore: ArtifactStore;
  let verificationService: VerificationService;
  let tmpDataDir: string;
  let project: Project;
  let task: Task;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-verif-cfg-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifactStore = new ArtifactStore(tmpDataDir);
    verificationService = new VerificationService(repo, artifactStore);

    project = {
      id: 'PROJ-VERIF-1',
      name: 'Verification Config Project',
      description: null,
      repository_path: tmpDataDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    repo.createProject(project);

    task = {
      id: 'TSK-VERIF-1',
      project_id: project.id,
      milestone_id: null,
      title: 'Verification Config Task',
      description: null,
      state: 'VALIDATING',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  it('fails closed when explicit commandConfigId does not exist', async () => {
    const res = await verificationService.runTests(
      project.id,
      task.id,
      null,
      project.repository_path,
      'non-existent-cmd-id'
    );

    expect(res.exit_code).toBe(-1);
    expect(res.failed_count).toBe(1);

    const ev = repo.getEvidence(res.evidence_id!)!;
    expect(ev.summary).toContain('Verification Configuration Failure');
    expect(artifactStore.read(ev)).toContain('VERIFICATION_CONFIG_NOT_FOUND');
  });

  it('fails closed when commandConfigId belongs to another project', async () => {
    // Create command on another project
    const otherProj: Project = {
      id: 'PROJ-OTHER',
      name: 'Other Project',
      description: null,
      repository_path: tmpDataDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    repo.createProject(otherProj);

    repo.createVerificationCommand({
      id: 'cmd-other',
      project_id: 'PROJ-OTHER',
      name: 'Other Tests',
      command_type: 'TEST',
      executable: 'node',
      args: ['test.js'],
      timeout_ms: 10000,
      enabled: true,
    });

    const res = await verificationService.runTests(
      project.id,
      task.id,
      null,
      project.repository_path,
      'cmd-other'
    );

    expect(res.exit_code).toBe(-1);
    const ev = repo.getEvidence(res.evidence_id!)!;
    expect(artifactStore.read(ev)).toContain('VERIFICATION_CROSS_PROJECT_MISMATCH');
  });

  it('fails closed when commandConfigId is disabled', async () => {
    repo.createVerificationCommand({
      id: 'cmd-disabled',
      project_id: project.id,
      name: 'Disabled Tests',
      command_type: 'TEST',
      executable: 'node',
      args: ['test.js'],
      timeout_ms: 10000,
      enabled: false,
    });

    const res = await verificationService.runTests(
      project.id,
      task.id,
      null,
      project.repository_path,
      'cmd-disabled'
    );

    expect(res.exit_code).toBe(-1);
    const ev = repo.getEvidence(res.evidence_id!)!;
    expect(artifactStore.read(ev)).toContain('VERIFICATION_CONFIG_DISABLED');
  });

  it('fails closed with VERIFICATION_NOT_CONFIGURED when no command config is supplied and project has no TEST command', async () => {
    const res = await verificationService.runTests(
      project.id,
      task.id,
      null,
      project.repository_path
    );

    expect(res.exit_code).toBe(-1);
    const ev = repo.getEvidence(res.evidence_id!)!;
    expect(artifactStore.read(ev)).toContain('VERIFICATION_NOT_CONFIGURED');
  });
});
