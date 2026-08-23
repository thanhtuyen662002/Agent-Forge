import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { ArtifactStore } from '../src/core/services/ArtifactStore';

describe('ProcessRunner Windows Command-Shim Resolution & Security Invariants', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let artifactStore: ArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-shim-test-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifactStore = new ArtifactStore(path.join(tmpDir, 'artifacts'));

    repo.createProject({
      id: 'PROJ-SHIM',
      name: 'Windows Shim Test Project',
      description: null,
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it.runIf(process.platform === 'win32')(
    'should execute real logical "npm test" on Windows through resolved npm.cmd shim without generic shell',
    async () => {
      // Create a minimal dependency-free fixture package
      const pkgJson = {
        name: 'windows-shim-fixture',
        version: '1.0.0',
        scripts: {
          test: 'node fixture.test.js',
        },
      };
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf8');
      fs.writeFileSync(
        path.join(tmpDir, 'fixture.test.js'),
        'console.log("FIXTURE_TEST_SUITE_PASSED_NATIVELY"); process.exit(0);',
        'utf8'
      );

      const res = await ProcessRunner.execute({
        executable: 'npm',
        args: ['test'],
        cwd: tmpDir,
        repo,
        artifactStore,
        projectId: 'PROJ-SHIM',
      });

      expect(res.exitCode).toBe(0);
      expect(res.pid).toBeTypeOf('number');
      expect(res.stdout).toContain('FIXTURE_TEST_SUITE_PASSED_NATIVELY');
      expect(res.command).toBe('npm test');

      const runRecord = repo.getProcessRun(res.executionId);
      expect(runRecord).not.toBeNull();
      expect(runRecord.status).toBe('COMPLETED');
      expect(runRecord.command).toBe('npm test');
      expect(runRecord.exit_code).toBe(0);
      expect(runRecord.pid).toBe(res.pid);
    }
  );

  it.runIf(process.platform === 'win32')(
    'should reject CRLF and NUL injection attempts before spawning child process',
    async () => {
      const crlfArg = 'test\ncalc.exe';
      const res = await ProcessRunner.execute({
        executable: 'npm',
        args: [crlfArg],
        cwd: tmpDir,
        repo,
        projectId: 'PROJ-SHIM',
      });

      expect(res.exitCode).toBe(-1);
      expect(res.pid).toBeNull();
      expect(res.stderr).toContain('Unsafe characters in command shim argument');

      const runRecord = repo.getProcessRun(res.executionId);
      expect(runRecord).not.toBeNull();
      expect(runRecord.status).toBe('FAILED');
      expect(runRecord.pid).toBeNull();
      expect(runRecord.command).toBe(`npm ${crlfArg}`);
    }
  );

  it.runIf(process.platform === 'win32')(
    'should reject shell command separator and metacharacter injection attempts before spawning child process',
    async () => {
      const dangerousArgSets = [
        ['test', '&', 'calc.exe'],
        ['test', '|', 'dir'],
        ['test', '%PATH%'],
        ['test', '<', 'in.txt'],
        ['test', '>', 'out.txt'],
        ['test', '^something'],
        ['test', 'double"quote'],
      ];

      for (const dangerousArgs of dangerousArgSets) {
        const res = await ProcessRunner.execute({
          executable: 'npm',
          args: dangerousArgs,
          cwd: tmpDir,
          repo,
          projectId: 'PROJ-SHIM',
        });

        expect(res.exitCode).toBe(-1);
        expect(res.pid).toBeNull();
        expect(res.stderr).toContain('Unsafe shell metacharacter in command shim argument');

        const runRecord = repo.getProcessRun(res.executionId);
        expect(runRecord).not.toBeNull();
        expect(runRecord.status).toBe('FAILED');
        expect(runRecord.pid).toBeNull();
      }
    }
  );

  it('should continue to directly spawn native executables like node script execution', async () => {
    const scriptPath = path.join(tmpDir, 'direct_script.js');
    fs.writeFileSync(scriptPath, 'console.log("DIRECT_NODE_EXEC_OK"); process.exit(0);', 'utf8');

    const res = await ProcessRunner.execute({
      executable: 'node',
      args: [scriptPath],
      cwd: tmpDir,
      repo,
      projectId: 'PROJ-SHIM',
    });

    expect(res.exitCode).toBe(0);
    expect(res.pid).toBeTypeOf('number');
    expect(res.stdout).toContain('DIRECT_NODE_EXEC_OK');

    const runRecord = repo.getProcessRun(res.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.status).toBe('COMPLETED');
    expect(runRecord.command).toBe(`node ${scriptPath}`);
  });

  it('should continue to block policy-denied commands like node -e without process spawn', async () => {
    const res = await ProcessRunner.execute({
      executable: 'node',
      args: ['-e', 'console.log("denied");'],
      cwd: tmpDir,
      repo,
      projectId: 'PROJ-SHIM',
    });

    expect(res.exitCode).toBe(-1);
    expect(res.pid).toBeNull();
    expect(res.stderr).toContain('Security Policy Violation');

    const runRecord = repo.getProcessRun(res.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.status).toBe('FAILED');
    expect(runRecord.pid).toBeNull();
  });
});
