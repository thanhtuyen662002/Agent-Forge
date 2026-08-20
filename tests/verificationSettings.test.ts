import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { CommandParser } from '../src/core/services/CommandParser';
import { PolicyService } from '../src/core/services/PolicyService';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import {
  GetVerificationCommandsIpcSchema,
  SaveVerificationCommandsIpcSchema,
} from '../src/core/types/ipc';
import { Project, Task } from '../src/core/types/domain';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('PR #14: Verification Settings Persistence & Parser', () => {
  describe('1. Command Parser', () => {
    it('parses basic command into structured executable and args', () => {
      const parsed = CommandParser.parse('node run_tests.js');
      expect(parsed).toEqual({
        executable: 'node',
        args: ['run_tests.js'],
      });
    });

    it('parses npm command with multiple arguments', () => {
      const parsed = CommandParser.parse('npm test -- --verbose --runInBand');
      expect(parsed).toEqual({
        executable: 'npm',
        args: ['test', '--', '--verbose', '--runInBand'],
      });
    });

    it('parses quoted arguments and paths preserving spaces', () => {
      const parsed = CommandParser.parse('node "scripts/run tests.js" --config="my config.json"');
      expect(parsed).toEqual({
        executable: 'node',
        args: ['scripts/run tests.js', '--config=my config.json'],
      });
    });

    it('parses single-quoted arguments', () => {
      const parsed = CommandParser.parse("pytest 'tests/test unit.py'");
      expect(parsed).toEqual({
        executable: 'pytest',
        args: ['tests/test unit.py'],
      });
    });

    it('returns null for blank or whitespace-only input', () => {
      expect(CommandParser.parse('')).toBeNull();
      expect(CommandParser.parse('   \t  ')).toBeNull();
    });

    it('rejects unterminated double quotes', () => {
      expect(() => CommandParser.parse('node "unclosed.js')).toThrow(
        /unterminated quotation mark/i
      );
    });

    it('rejects unterminated single quotes', () => {
      expect(() => CommandParser.parse("node 'unclosed.js")).toThrow(
        /unterminated quotation mark/i
      );
    });

    it('rejects invalid control characters', () => {
      expect(() => CommandParser.parse('node\x00malicious.js')).toThrow(
        /invalid control characters/i
      );
      expect(() => CommandParser.parse('node\nrun.js')).toThrow(
        /invalid control characters/i
      );
    });
  });

  describe('2. Repository Persistence & Project Isolation', () => {
    let db: Database.Database;
    let repo: Repository;
    let projectA: Project;
    let projectB: Project;

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      MigrationRunner.run(db);
      repo = new Repository(db);

      const now = new Date().toISOString();
      projectA = {
        id: 'PROJ-AAA',
        name: 'Project Alpha',
        description: null,
        repository_path: 'C:\\fake\\alpha',
        default_branch: 'main',
        status: 'READY',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      };
      projectB = {
        id: 'PROJ-BBB',
        name: 'Project Beta',
        description: null,
        repository_path: 'C:\\fake\\beta',
        default_branch: 'main',
        status: 'READY',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      };
      repo.createProject(projectA);
      repo.createProject(projectB);
    });

    afterEach(() => {
      db.close();
    });

    it('fresh project has 0 verification commands in SQLite', () => {
      const cmdsA = repo.getVerificationCommandsByProject(projectA.id);
      const cmdsB = repo.getVerificationCommandsByProject(projectB.id);
      expect(cmdsA).toHaveLength(0);
      expect(cmdsB).toHaveLength(0);
    });

    it('saves and roundtrips TEST command', () => {
      repo.setProjectVerificationCommands(projectA.id, {
        TEST: { executable: 'npm', args: ['test'] },
      });

      const cmds = repo.getVerificationCommandsByProject(projectA.id);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].command_type).toBe('TEST');
      expect(cmds[0].executable).toBe('npm');
      expect(cmds[0].args).toEqual(['test']);
      expect(cmds[0].enabled).toBe(true);
    });

    it('repeated save updates the existing command without creating duplicates', () => {
      repo.setProjectVerificationCommands(projectA.id, {
        TEST: { executable: 'npm', args: ['test'] },
      });
      repo.setProjectVerificationCommands(projectA.id, {
        TEST: { executable: 'pytest', args: ['-v'] },
      });

      const cmds = repo.getVerificationCommandsByProject(projectA.id);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].command_type).toBe('TEST');
      expect(cmds[0].executable).toBe('pytest');
      expect(cmds[0].args).toEqual(['-v']);
    });

    it('saving blank (null) removes/deletes the command type', () => {
      repo.setProjectVerificationCommands(projectA.id, {
        TEST: { executable: 'npm', args: ['test'] },
        LINT: { executable: 'npm', args: ['run', 'lint'] },
      });
      expect(repo.getVerificationCommandsByProject(projectA.id)).toHaveLength(2);

      repo.setProjectVerificationCommands(projectA.id, {
        TEST: null,
      });

      const cmds = repo.getVerificationCommandsByProject(projectA.id);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].command_type).toBe('LINT');
    });

    it('manages TEST, LINT, and BUILD independently', () => {
      repo.setProjectVerificationCommands(projectA.id, {
        TEST: { executable: 'npm', args: ['test'] },
        LINT: { executable: 'npm', args: ['run', 'lint'] },
        BUILD: { executable: 'npm', args: ['run', 'build'] },
      });

      const cmds = repo.getVerificationCommandsByProject(projectA.id);
      expect(cmds).toHaveLength(3);
      const types = cmds.map((c) => c.command_type).sort();
      expect(types).toEqual(['BUILD', 'LINT', 'TEST']);
    });

    it('guarantees project isolation: Project A configuration never leaks to Project B', () => {
      repo.setProjectVerificationCommands(projectA.id, {
        TEST: { executable: 'node', args: ['run_tests.js'] },
      });

      const cmdsA = repo.getVerificationCommandsByProject(projectA.id);
      const cmdsB = repo.getVerificationCommandsByProject(projectB.id);

      expect(cmdsA).toHaveLength(1);
      expect(cmdsA[0].executable).toBe('node');
      expect(cmdsB).toHaveLength(0);
    });

    it('preserves existing TYPECHECK configuration and other command types', () => {
      repo.createVerificationCommand({
        id: 'cmd-typecheck-1',
        project_id: projectA.id,
        name: 'Typecheck Suite',
        command_type: 'TYPECHECK',
        executable: 'tsc',
        args: ['--noEmit'],
        timeout_ms: 60000,
        enabled: true,
      });

      repo.setProjectVerificationCommands(projectA.id, {
        TEST: { executable: 'npm', args: ['test'] },
      });

      const cmds = repo.getVerificationCommandsByProject(projectA.id);
      expect(cmds).toHaveLength(2);
      expect(cmds.find((c) => c.command_type === 'TYPECHECK')).toBeDefined();
      expect(cmds.find((c) => c.command_type === 'TEST')).toBeDefined();
    });
  });

  describe('3. IPC Schema Validation & Security Policy Enforcement', () => {
    it('validates GetVerificationCommandsIpcSchema strictly', () => {
      const valid = GetVerificationCommandsIpcSchema.safeParse({ projectId: 'PROJ-123' });
      expect(valid.success).toBe(true);

      const invalidExtra = GetVerificationCommandsIpcSchema.safeParse({
        projectId: 'PROJ-123',
        extra: 'not-allowed',
      });
      expect(invalidExtra.success).toBe(false);

      const invalidEmpty = GetVerificationCommandsIpcSchema.safeParse({ projectId: '' });
      expect(invalidEmpty.success).toBe(false);
    });

    it('validates SaveVerificationCommandsIpcSchema strictly', () => {
      const valid = SaveVerificationCommandsIpcSchema.safeParse({
        projectId: 'PROJ-123',
        commands: {
          TEST: 'npm test',
          LINT: 'npm run lint',
          BUILD: null,
        },
      });
      expect(valid.success).toBe(true);

      const invalidExtra = SaveVerificationCommandsIpcSchema.safeParse({
        projectId: 'PROJ-123',
        commands: {
          TEST: 'npm test',
          UNKNOWN_TYPE: 'foo',
        },
      });
      expect(invalidExtra.success).toBe(false);
    });

    it('evaluates commands against PolicyService before execution', () => {
      const parsedSafe = CommandParser.parse('npm test')!;
      const policySafe = PolicyService.evaluateProcessExecution(parsedSafe.executable, parsedSafe.args, false);
      expect(policySafe.allowed).toBe(true);

      const parsedBlocked = CommandParser.parse('powershell.exe -Command rm -rf /')!;
      const policyBlocked = PolicyService.evaluateProcessExecution(parsedBlocked.executable, parsedBlocked.args, false);
      expect(policyBlocked.allowed).toBe(false);
    });
  });

  describe('4. VerificationService Discovery after Owner Configuration', () => {
    let db: Database.Database;
    let repo: Repository;
    let artifactStore: ArtifactStore;
    let verificationService: VerificationService;
    let tmpDataDir: string;
    let project: Project;
    let task: Task;

    beforeEach(() => {
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-verif-discovery-'));
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      MigrationRunner.run(db);
      repo = new Repository(db);
      artifactStore = new ArtifactStore(tmpDataDir);
      verificationService = new VerificationService(repo, artifactStore);

      const now = new Date().toISOString();
      project = {
        id: 'PROJ-DISCOVERY-1',
        name: 'Discovery Project',
        description: null,
        repository_path: tmpDataDir,
        default_branch: 'main',
        status: 'READY',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      };
      repo.createProject(project);

      task = {
        id: 'TSK-DISCOVERY-1',
        project_id: project.id,
        milestone_id: null,
        title: 'Discovery Task',
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
        created_at: now,
        updated_at: now,
      };
      repo.createTask(task);
    });

    afterEach(() => {
      db.close();
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    it('fails closed when project is freshly created with 0 commands', async () => {
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

    it('discovers and executes TEST command after Owner configures it', async () => {
      // Create a small test script in tmpDataDir
      const scriptPath = path.join(tmpDataDir, 'run_pass.js');
      fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf-8');

      // Owner saves TEST command via production persistence
      repo.setProjectVerificationCommands(project.id, {
        TEST: { executable: 'node', args: [scriptPath] },
      });

      // VerificationService runs tests without explicit commandConfigId
      const res = await verificationService.runTests(
        project.id,
        task.id,
        null,
        project.repository_path
      );

      expect(res.exit_code).toBe(0);
      expect(res.passed_count).toBe(1);
      expect(res.failed_count).toBe(0);
    });
  });
});
