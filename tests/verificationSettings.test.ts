import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { CommandParser, ParsedCommand } from '../src/core/services/CommandParser';
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
  describe('1. Command Parser & Windows Path Handling', () => {
    it('CASE 1: parses basic command into structured executable and args', () => {
      const parsed = CommandParser.parse('node run_tests.js');
      expect(parsed).toEqual({
        executable: 'node',
        args: ['run_tests.js'],
      });
    });

    it('CASE 2: parses command with quoted spaced argument', () => {
      const parsed = CommandParser.parse('node "scripts/run tests.js"');
      expect(parsed).toEqual({
        executable: 'node',
        args: ['scripts/run tests.js'],
      });
    });

    it('CASE 3: preserves exact Windows backslashes in quoted path', () => {
      const parsed = CommandParser.parse('node "C:\\Users\\Test User\\repo\\run_tests.js"');
      expect(parsed).toEqual({
        executable: 'node',
        args: ['C:\\Users\\Test User\\repo\\run_tests.js'],
      });
    });

    it('CASE 4: preserves quoted executable with spaces and quoted Windows argument', () => {
      const parsed = CommandParser.parse('"C:\\Program Files\\nodejs\\node.exe" "scripts\\run tests.js"');
      expect(parsed).toEqual({
        executable: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['scripts\\run tests.js'],
      });
    });

    it('CASE 5: preserves unquoted Windows backslashes in path argument', () => {
      const parsed = CommandParser.parse('node C:\\repo\\run_tests.js');
      expect(parsed).toEqual({
        executable: 'node',
        args: ['C:\\repo\\run_tests.js'],
      });
    });

    it('CASE 6: preserves leading UNC backslashes and remaining path separators', () => {
      const parsed = CommandParser.parse('node "\\\\server\\share folder\\run_tests.js"');
      expect(parsed).toEqual({
        executable: 'node',
        args: ['\\\\server\\share folder\\run_tests.js'],
      });
    });

    it('CASE 7: rejects unterminated double quotes', () => {
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

    it('returns null for blank or whitespace-only input', () => {
      expect(CommandParser.parse('')).toBeNull();
      expect(CommandParser.parse('   \t  ')).toBeNull();
    });
  });

  describe('2. Canonical Command Formatter & parse(format(cmd)) Round-Trip Property', () => {
    const assertRoundTrip = (cmd: ParsedCommand) => {
      const formatted = CommandParser.format(cmd);
      const parsed = CommandParser.parse(formatted);
      expect(parsed).toEqual(cmd);
    };

    it('round-trips basic command with no spaces', () => {
      assertRoundTrip({
        executable: 'npm',
        args: ['test'],
      });
    });

    it('round-trips command with spaces in arguments', () => {
      assertRoundTrip({
        executable: 'node',
        args: ['scripts/run tests.js'],
      });
    });

    it('round-trips command with Windows path containing spaces', () => {
      assertRoundTrip({
        executable: 'node',
        args: ['C:\\Users\\Test User\\repo\\run_tests.js'],
      });
    });

    it('round-trips command with spaces in executable path', () => {
      assertRoundTrip({
        executable: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['scripts\\run tests.js'],
      });
    });

    it('round-trips command with multiple mixed arguments', () => {
      assertRoundTrip({
        executable: 'node',
        args: ['--max-old-space-size=4096', 'scripts/run tests.js', '-v', '--bail'],
      });
    });

    it('round-trips command with empty args array', () => {
      assertRoundTrip({
        executable: 'npm',
        args: [],
      });
    });

    it('round-trips command with UNC path', () => {
      assertRoundTrip({
        executable: 'node',
        args: ['\\\\server\\share folder\\run_tests.js'],
      });
    });
  });

  describe('3. Repository Persistence & Project Isolation', () => {
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

    it('SAVE -> LOAD -> SAVE Immutability: preserves exact argument boundaries without user edit', () => {
      // 1. Owner enters input with spaced argument
      const inputString = 'node "scripts/run tests.js"';
      const parsed1 = CommandParser.parse(inputString)!;
      expect(parsed1).toEqual({ executable: 'node', args: ['scripts/run tests.js'] });

      // 2. Persist to SQLite
      repo.setProjectVerificationCommands(projectA.id, { TEST: parsed1 });

      // 3. Reload from SQLite
      const loadedCmds = repo.getVerificationCommandsByProject(projectA.id);
      const testRow = loadedCmds.find((c) => c.command_type === 'TEST')!;
      expect(testRow.executable).toBe('node');
      expect(testRow.args).toEqual(['scripts/run tests.js']);

      // 4. Renderer formats using canonical formatter
      const formattedForUI = CommandParser.format(testRow);
      expect(formattedForUI).toBe('node "scripts/run tests.js"');

      // 5. Save again without edits
      const parsed2 = CommandParser.parse(formattedForUI)!;
      repo.setProjectVerificationCommands(projectA.id, { TEST: parsed2 });

      // 6. Assert SQLite remains exactly unchanged
      const reloadedCmds = repo.getVerificationCommandsByProject(projectA.id);
      const testRowReloaded = reloadedCmds.find((c) => c.command_type === 'TEST')!;
      expect(testRowReloaded.executable).toBe('node');
      expect(testRowReloaded.args).toEqual(['scripts/run tests.js']);
    });

    it('SAVE -> LOAD -> SAVE Windows Path Immutability', () => {
      const inputString = '"C:\\Program Files\\nodejs\\node.exe" "scripts\\run tests.js"';
      const parsed1 = CommandParser.parse(inputString)!;
      expect(parsed1).toEqual({
        executable: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['scripts\\run tests.js'],
      });

      repo.setProjectVerificationCommands(projectA.id, { TEST: parsed1 });

      const loadedCmds = repo.getVerificationCommandsByProject(projectA.id);
      const testRow = loadedCmds.find((c) => c.command_type === 'TEST')!;
      const formattedForUI = CommandParser.format(testRow);
      expect(formattedForUI).toBe('"C:\\Program Files\\nodejs\\node.exe" "scripts\\run tests.js"');

      const parsed2 = CommandParser.parse(formattedForUI)!;
      repo.setProjectVerificationCommands(projectA.id, { TEST: parsed2 });

      const reloadedCmds = repo.getVerificationCommandsByProject(projectA.id);
      const testRowReloaded = reloadedCmds.find((c) => c.command_type === 'TEST')!;
      expect(testRowReloaded.executable).toBe('C:\\Program Files\\nodejs\\node.exe');
      expect(testRowReloaded.args).toEqual(['scripts\\run tests.js']);
    });

    it('PROJECT SWITCH ROUND-TRIP: switching A -> B -> A reconstructs both commands losslessly', () => {
      // Project A has spaced path
      const parsedA = CommandParser.parse('node "scripts/A tests.js"')!;
      repo.setProjectVerificationCommands(projectA.id, { TEST: parsedA });

      // Project B has Windows spaced path
      const parsedB = CommandParser.parse('"C:\\Program Files\\nodejs\\node.exe" "scripts\\B tests.js"')!;
      repo.setProjectVerificationCommands(projectB.id, { TEST: parsedB });

      // Load A
      const rowsA1 = repo.getVerificationCommandsByProject(projectA.id);
      expect(CommandParser.format(rowsA1[0])).toBe('node "scripts/A tests.js"');

      // Switch to B
      const rowsB = repo.getVerificationCommandsByProject(projectB.id);
      expect(CommandParser.format(rowsB[0])).toBe('"C:\\Program Files\\nodejs\\node.exe" "scripts\\B tests.js"');

      // Switch back to A
      const rowsA2 = repo.getVerificationCommandsByProject(projectA.id);
      expect(CommandParser.format(rowsA2[0])).toBe('node "scripts/A tests.js"');
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

  describe('4. IPC Schema Validation & Nonexistent Project Rejection', () => {
    let db: Database.Database;
    let repo: Repository;

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      MigrationRunner.run(db);
      repo = new Repository(db);
    });

    afterEach(() => {
      db.close();
    });

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

    it('nonexistent project save fails closed with zero SQLite DB mutation', () => {
      const nonexistentProjectId = 'PROJ-DOES-NOT-EXIST';

      // Verify project does not exist
      const project = repo.getProject(nonexistentProjectId);
      expect(project).toBeNull();

      // Attempting to write verification commands for nonexistent project fails foreign key constraint or project check
      expect(() => {
        repo.setProjectVerificationCommands(nonexistentProjectId, {
          TEST: { executable: 'npm', args: ['test'] },
        });
      }).toThrow();

      // Verify 0 rows exist in verification_commands
      const allRows = db.prepare('SELECT * FROM verification_commands').all();
      expect(allRows).toHaveLength(0);
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

  describe('5. VerificationService Discovery after Owner Configuration', () => {
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
      const scriptPath = path.join(tmpDataDir, 'run_pass.js');
      fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf-8');

      repo.setProjectVerificationCommands(project.id, {
        TEST: { executable: 'node', args: [scriptPath] },
      });

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
