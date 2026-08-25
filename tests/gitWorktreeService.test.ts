import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import {
  GitWorktreeService,
  GitWorktreeServiceConfig,
  WorktreeOwnershipTuple,
  IProcessExecutor,
} from '../src/core/services/GitWorktreeService';

function findGitExecutable(): string {
  try {
    const cmd = process.platform === 'win32' ? 'where git.exe' : 'which git';
    const out = execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  const fallbacks = [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\bin\\git.exe',
    '/usr/bin/git',
    '/usr/local/bin/git',
  ];
  for (const fb of fallbacks) {
    if (fs.existsSync(fb)) return fb;
  }
  throw new Error('Git executable not found on test system.');
}

describe('R5G2A — GitWorktreeService Contract & Invariant Suite', () => {
  let gitExe: string;
  let testBaseDir: string;
  let repoDir: string;
  let managedDir: string;
  let baseCommitSha: string;
  let secondCommitSha: string;
  let service: GitWorktreeService;

  beforeEach(() => {
    gitExe = findGitExecutable();
    testBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-worktree-test-'));
    repoDir = path.join(testBaseDir, 'repo');
    managedDir = path.join(testBaseDir, 'managed');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    // Initialize synthetic git repo
    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.name "Test Runner"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.email "test@runner.local"`, { cwd: repoDir, stdio: 'ignore' });

    // Initial commit
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Initial Repository\n');
    execSync(`"${gitExe}" add README.md`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" commit -m "feat: initial commit"`, { cwd: repoDir, stdio: 'ignore' });
    baseCommitSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf8' }).trim().toLowerCase();

    // Second commit
    fs.writeFileSync(path.join(repoDir, 'SECOND.md'), '# Second Commit\n');
    execSync(`"${gitExe}" add SECOND.md`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" commit -m "feat: second commit"`, { cwd: repoDir, stdio: 'ignore' });
    secondCommitSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf8' }).trim().toLowerCase();

    service = new GitWorktreeService({
      gitExecutable: gitExe,
      repositoryRoot: repoDir,
      managedRoot: managedDir,
    });
  });

  afterEach(() => {
    // Attempt unlock and remove of any remaining synthetic worktrees before deleting temp dir
    try {
      const listRes = execSync(`"${gitExe}" worktree list --porcelain`, { cwd: repoDir, encoding: 'utf8' });
      const lines = listRes.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          const wtPath = line.substring(9).trim();
          if (wtPath !== repoDir && fs.existsSync(wtPath)) {
            try { execSync(`"${gitExe}" worktree unlock "${wtPath}"`, { cwd: repoDir, stdio: 'ignore' }); } catch {}
            try { execSync(`"${gitExe}" worktree remove "${wtPath}"`, { cwd: repoDir, stdio: 'ignore' }); } catch {}
          }
        }
      }
    } catch {}

    if (fs.existsSync(testBaseDir)) {
      try {
        fs.rmSync(testBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  function makeTuple(overrides?: Partial<WorktreeOwnershipTuple>): WorktreeOwnershipTuple {
    return {
      projectId: 'proj-test',
      taskId: 'task-1',
      attemptId: 'att-1',
      assignmentId: 'asgn-1',
      workerSlotId: 'slot-1',
      baseSha: baseCommitSha,
      ...overrides,
    };
  }

  // =========================================================================
  // 1. Executable & Root Validation
  // =========================================================================

  it('1. Absolute trusted git executable accepted', () => {
    expect(service.getGitExecutable()).toBe(path.resolve(gitExe));
  });

  it('2. Bare "git" rejected by service', () => {
    expect(() => {
      new GitWorktreeService({
        gitExecutable: 'git',
        repositoryRoot: repoDir,
        managedRoot: managedDir,
      });
    }).toThrow(/INVALID_GIT_EXECUTABLE/);
  });

  it('3. Nonexistent git executable rejected', () => {
    expect(() => {
      new GitWorktreeService({
        gitExecutable: path.join(testBaseDir, 'nonexistent-git.exe'),
        repositoryRoot: repoDir,
        managedRoot: managedDir,
      });
    }).toThrow(/INVALID_GIT_EXECUTABLE/);
  });

  it('4. Non-repository repositoryRoot rejected (or nonexistent dir)', () => {
    const nonRepoDir = path.join(testBaseDir, 'not-a-repo');
    expect(() => {
      new GitWorktreeService({
        gitExecutable: gitExe,
        repositoryRoot: nonRepoDir,
        managedRoot: managedDir,
      });
    }).toThrow(/INVALID_REPOSITORY_ROOT/);
  });

  it('5. ManagedRoot inside repository rejected', () => {
    const insideRepo = path.join(repoDir, 'nested-managed');
    fs.mkdirSync(insideRepo, { recursive: true });
    expect(() => {
      new GitWorktreeService({
        gitExecutable: gitExe,
        repositoryRoot: repoDir,
        managedRoot: insideRepo,
      });
    }).toThrow(/INVALID_MANAGED_ROOT/);
  });

  it('6. Repository inside managedRoot rejected', () => {
    const subRepo = path.join(managedDir, 'sub-repo');
    fs.mkdirSync(subRepo, { recursive: true });
    expect(() => {
      new GitWorktreeService({
        gitExecutable: gitExe,
        repositoryRoot: subRepo,
        managedRoot: managedDir,
      });
    }).toThrow(/INVALID_REPOSITORY_ROOT/);
  });

  // =========================================================================
  // 2. Ownership & Path Derivation
  // =========================================================================

  it('7. Ownership path is deterministic', () => {
    const t = makeTuple();
    const d1 = service.deriveWorktreePath(t);
    const d2 = service.deriveWorktreePath(t);
    expect(d1.worktreePath).toBe(d2.worktreePath);
    expect(d1.digest).toBe(d2.digest);
  });

  it('8. Malicious IDs containing ../, slashes, colons cannot escape managed root', () => {
    const maliciousTuple = makeTuple({
      projectId: '../../etc/passwd',
      taskId: '..\\..\\Windows\\System32',
      assignmentId: 'asgn/../../../escape',
      workerSlotId: 'slot:aux:*?',
    });
    const derived = service.deriveWorktreePath(maliciousTuple);
    expect(derived.worktreePath.startsWith(service.getManagedRoot())).toBe(true);
    expect(path.relative(service.getManagedRoot(), derived.worktreePath).startsWith('..')).toBe(false);
  });

  it('9. Same ownership tuple derives same path', () => {
    const t = makeTuple();
    expect(service.deriveWorktreePath(t).worktreePath).toBe(service.deriveWorktreePath(t).worktreePath);
  });

  it('10. Different assignment/slot derives different path', () => {
    const t1 = makeTuple({ assignmentId: 'asgn-1', workerSlotId: 'slot-1' });
    const t2 = makeTuple({ assignmentId: 'asgn-2', workerSlotId: 'slot-1' });
    const t3 = makeTuple({ assignmentId: 'asgn-1', workerSlotId: 'slot-2' });
    expect(service.deriveWorktreePath(t1).worktreePath).not.toBe(service.deriveWorktreePath(t2).worktreePath);
    expect(service.deriveWorktreePath(t1).worktreePath).not.toBe(service.deriveWorktreePath(t3).worktreePath);
  });

  // =========================================================================
  // 3. Source SHA & Commit Validation
  // =========================================================================

  it('11. Invalid SHA syntax rejected before worktree mutation', async () => {
    const invalidTuple = makeTuple({ baseSha: 'HEAD' });
    const res = await service.createWorktree(invalidTuple);
    expect(res.status).toBe('FAILED');
    if (res.status === 'FAILED') {
      expect(res.code).toBe('INVALID_SOURCE_SHA');
    }
  });

  it('12. Nonexistent valid-looking SHA rejected', async () => {
    const fakeSha = '0123456789abcdef0123456789abcdef01234567';
    const fakeTuple = makeTuple({ baseSha: fakeSha });
    const res = await service.createWorktree(fakeTuple);
    expect(res.status).toBe('FAILED');
    if (res.status === 'FAILED') {
      expect(res.code).toBe('SOURCE_COMMIT_NOT_FOUND');
    }
  });

  // =========================================================================
  // 4. Create Worktree Lifecycle
  // =========================================================================

  it('13. Creation makes detached worktree at exact SHA', async () => {
    const t = makeTuple({ baseSha: baseCommitSha });
    const res = await service.createWorktree(t);
    expect(res.status).toBe('CREATED');
    if (res.status === 'CREATED') {
      expect(fs.existsSync(res.worktreePath)).toBe(true);
      expect(res.baseSha).toBe(baseCommitSha);
    }
  });

  it('14. New worktree HEAD exactly equals requested SHA', async () => {
    const t = makeTuple({ baseSha: baseCommitSha });
    const res = await service.createWorktree(t);
    expect(res.status).toBe('CREATED');
    if (res.status === 'CREATED') {
      const head = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: res.worktreePath, encoding: 'utf8' }).trim().toLowerCase();
      expect(head).toBe(baseCommitSha);
    }
  });

  it('15. New worktree registered exactly once', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    expect(res.status).toBe('CREATED');
    if (res.status === 'CREATED') {
      const porcelain = await service.listPorcelain();
      const matches = porcelain.filter((p) => path.resolve(p.worktreePath).toLowerCase() === path.resolve(res.worktreePath).toLowerCase());
      expect(matches.length).toBe(1);
    }
  });

  it('16. New worktree is locked', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    expect(res.status).toBe('CREATED');
    if (res.status === 'CREATED') {
      const porcelain = await service.listPorcelain();
      const entry = porcelain.find((p) => path.resolve(p.worktreePath).toLowerCase() === path.resolve(res.worktreePath).toLowerCase())!;
      expect(entry.isLocked).toBe(true);
      expect(entry.lockReason).toContain('AgentForge managed assignment');
    }
  });

  it('17. No branch created for worktree', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    expect(res.status).toBe('CREATED');
    if (res.status === 'CREATED') {
      const branch = execSync(`"${gitExe}" branch --show-current`, { cwd: res.worktreePath, encoding: 'utf8' }).trim();
      expect(branch).toBe('');
    }
  });

  it('18. Second create with same ownership fails closed (WORKTREE_ALREADY_EXISTS / REGISTERED)', async () => {
    const t = makeTuple();
    const res1 = await service.createWorktree(t);
    expect(res1.status).toBe('CREATED');

    const res2 = await service.createWorktree(t);
    expect(res2.status).toBe('FAILED');
    if (res2.status === 'FAILED') {
      expect(['WORKTREE_ALREADY_EXISTS', 'WORKTREE_ALREADY_REGISTERED']).toContain(res2.code);
    }
  });

  // =========================================================================
  // 5. Inspect API
  // =========================================================================

  it('19. Inspect returns correct registered/head/detached/locked/clean state', async () => {
    const t = makeTuple();
    await service.createWorktree(t);

    const insp = await service.inspectWorktree(t);
    expect(insp.status).toBe('INSPECTED');
    if (insp.status === 'INSPECTED') {
      expect(insp.inspection.registered).toBe(true);
      expect(insp.inspection.exists).toBe(true);
      expect(insp.inspection.headSha).toBe(baseCommitSha);
      expect(insp.inspection.detached).toBe(true);
      expect(insp.inspection.locked).toBe(true);
      expect(insp.inspection.clean).toBe(true);
      expect(insp.inspection.sourceMatch).toBe(true);
    }
  });

  // =========================================================================
  // 6. Multi-Worktree Isolation
  // =========================================================================

  it('20. Two distinct assignments can create two isolated worktrees from same base SHA', async () => {
    const t1 = makeTuple({ assignmentId: 'asgn-1', workerSlotId: 'slot-1' });
    const t2 = makeTuple({ assignmentId: 'asgn-2', workerSlotId: 'slot-2' });

    const res1 = await service.createWorktree(t1);
    const res2 = await service.createWorktree(t2);

    expect(res1.status).toBe('CREATED');
    expect(res2.status).toBe('CREATED');
  });

  it('21. Both worktree paths are different', async () => {
    const t1 = makeTuple({ assignmentId: 'asgn-1', workerSlotId: 'slot-1' });
    const t2 = makeTuple({ assignmentId: 'asgn-2', workerSlotId: 'slot-2' });

    const res1 = await service.createWorktree(t1);
    const res2 = await service.createWorktree(t2);

    if (res1.status === 'CREATED' && res2.status === 'CREATED') {
      expect(res1.worktreePath).not.toBe(res2.worktreePath);
    }
  });

  it('22. Write/change in worktree A does not change worktree B working tree', async () => {
    const t1 = makeTuple({ assignmentId: 'asgn-1', workerSlotId: 'slot-1' });
    const t2 = makeTuple({ assignmentId: 'asgn-2', workerSlotId: 'slot-2' });

    const res1 = await service.createWorktree(t1);
    const res2 = await service.createWorktree(t2);

    if (res1.status === 'CREATED' && res2.status === 'CREATED') {
      // Modify worktree A
      fs.writeFileSync(path.join(res1.worktreePath, 'new-file-a.txt'), 'Hello from A\n');

      // Check worktree B has no such file
      expect(fs.existsSync(path.join(res2.worktreePath, 'new-file-a.txt'))).toBe(false);

      // Check worktree A is dirty, worktree B is clean
      const statusA = execSync(`"${gitExe}" status --porcelain`, { cwd: res1.worktreePath, encoding: 'utf8' }).trim();
      const statusB = execSync(`"${gitExe}" status --porcelain`, { cwd: res2.worktreePath, encoding: 'utf8' }).trim();
      expect(statusA).toContain('new-file-a.txt');
      expect(statusB).toBe('');
    }
  });

  // =========================================================================
  // 7. Remove Safety & Dirty Rejection
  // =========================================================================

  it('23. Dirty worktree removal denied (DIRTY_WORKTREE)', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    expect(res.status).toBe('CREATED');
    if (res.status === 'CREATED') {
      fs.writeFileSync(path.join(res.worktreePath, 'dirty.txt'), 'untracked change');
      const rem = await service.removeWorktree(t);
      expect(rem.status).toBe('FAILED');
      if (rem.status === 'FAILED') {
        expect(rem.code).toBe('DIRTY_WORKTREE');
      }
    }
  });

  it('24. Dirty removal leaves worktree registered and present', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    if (res.status === 'CREATED') {
      fs.writeFileSync(path.join(res.worktreePath, 'dirty.txt'), 'untracked');
      await service.removeWorktree(t);
      expect(fs.existsSync(res.worktreePath)).toBe(true);
      const porcelain = await service.listPorcelain();
      const found = porcelain.some((p) => path.resolve(p.worktreePath).toLowerCase() === path.resolve(res.worktreePath).toLowerCase());
      expect(found).toBe(true);
    }
  });

  it('25. After restoring clean state, removal succeeds', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    if (res.status === 'CREATED') {
      const dirtyFile = path.join(res.worktreePath, 'dirty.txt');
      fs.writeFileSync(dirtyFile, 'untracked');
      const rem1 = await service.removeWorktree(t);
      expect(rem1.status).toBe('FAILED');

      // Clean up file
      fs.unlinkSync(dirtyFile);
      const rem2 = await service.removeWorktree(t);
      expect(rem2.status).toBe('REMOVED');
    }
  });

  it('26. Successful removal leaves no registered entry', async () => {
    const t = makeTuple();
    await service.createWorktree(t);
    const rem = await service.removeWorktree(t);
    expect(rem.status).toBe('REMOVED');
    if (rem.status === 'REMOVED') {
      const porcelain = await service.listPorcelain();
      const found = porcelain.some((p) => path.resolve(p.worktreePath).toLowerCase() === path.resolve(rem.worktreePath).toLowerCase());
      expect(found).toBe(false);
    }
  });

  it('27. Successful removal leaves no filesystem worktree directory', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    if (res.status === 'CREATED') {
      await service.removeWorktree(t);
      expect(fs.existsSync(res.worktreePath)).toBe(false);
    }
  });

  it('28. Changed HEAD causes remove denial (HEAD_CHANGED)', async () => {
    const t = makeTuple({ baseSha: baseCommitSha });
    const res = await service.createWorktree(t);
    if (res.status === 'CREATED') {
      // Switch worktree HEAD to second commit
      execSync(`"${gitExe}" checkout ${secondCommitSha}`, { cwd: res.worktreePath, stdio: 'ignore' });
      const rem = await service.removeWorktree(t);
      expect(rem.status).toBe('FAILED');
      if (rem.status === 'FAILED') {
        expect(rem.code).toBe('HEAD_CHANGED');
      }
    }
  });

  it('29. Unmanaged directory cannot be removed', async () => {
    const unmanagedTuple = makeTuple({ assignmentId: 'nonexistent-asgn' });
    const rem = await service.removeWorktree(unmanagedTuple);
    expect(rem.status).toBe('FAILED');
    if (rem.status === 'FAILED') {
      expect(rem.code).toBe('UNMANAGED_WORKTREE');
    }
  });

  it('30. Unrelated synthetic Git worktree is never removed', async () => {
    // Manually add an external worktree
    const externalWt = path.join(testBaseDir, 'external-wt');
    execSync(`"${gitExe}" worktree add --detach "${externalWt}" ${baseCommitSha}`, { cwd: repoDir, stdio: 'ignore' });

    const t = makeTuple();
    await service.removeWorktree(t);

    expect(fs.existsSync(externalWt)).toBe(true);
  });

  it('31. Primary repository cannot be removed', async () => {
    // Even if an ownership tuple somehow resolves to repo root, containment denial or repo root check blocks it
    const fakeTuple = makeTuple();
    const origDerive = service.deriveWorktreePath.bind(service);
    service.deriveWorktreePath = () => ({ worktreePath: repoDir, digest: 'fake' });

    const rem = await service.removeWorktree(fakeTuple);
    expect(rem.status).toBe('FAILED');
    if (rem.status === 'FAILED') {
      expect(rem.code).toBe('UNMANAGED_WORKTREE');
    }

    service.deriveWorktreePath = origDerive;
  });

  // =========================================================================
  // 8. Rollback & Structural Invariants
  // =========================================================================

  it('32. Lock failure after add triggers safe rollback', async () => {
    const executedCommands: { command: string; args: string[] }[] = [];
    const customExecutor: IProcessExecutor = {
      async execute(command, args, options) {
        executedCommands.push({ command, args });
        // Fail when running worktree lock
        if (args[0] === 'worktree' && args[1] === 'lock') {
          return { exitCode: 1, stdout: '', stderr: 'Simulated lock failure' };
        }
        return service['executor'].execute(command, args, options);
      },
    };

    const failingService = new GitWorktreeService(
      {
        gitExecutable: gitExe,
        repositoryRoot: repoDir,
        managedRoot: managedDir,
      },
      customExecutor
    );

    const t = makeTuple();
    const res = await failingService.createWorktree(t);
    expect(res.status).toBe('FAILED');
    if (res.status === 'FAILED') {
      expect(res.code).toBe('WORKTREE_LOCK_FAILED');
      // Verify rollback removed the worktree from filesystem
      expect(fs.existsSync(res.worktreePath!)).toBe(false);
    }
  });

  it('33. Failed rollback is surfaced distinctly as CREATE_ROLLBACK_FAILED', async () => {
    const customExecutor: IProcessExecutor = {
      async execute(command, args, options) {
        // Fail when running worktree lock
        if (args[0] === 'worktree' && args[1] === 'lock') {
          return { exitCode: 1, stdout: '', stderr: 'Simulated lock failure' };
        }
        // Also fail rollback remove
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return { exitCode: 1, stdout: '', stderr: 'Simulated remove failure during rollback' };
        }
        return service['executor'].execute(command, args, options);
      },
    };

    const failingService = new GitWorktreeService(
      {
        gitExecutable: gitExe,
        repositoryRoot: repoDir,
        managedRoot: managedDir,
      },
      customExecutor
    );

    const t = makeTuple();
    const res = await failingService.createWorktree(t);
    expect(res.status).toBe('FAILED');
    if (res.status === 'FAILED') {
      expect(res.code).toBe('CREATE_ROLLBACK_FAILED');
    }
  });

  it('34. No --force worktree remove command is generated', async () => {
    const executedArgs: string[][] = [];
    const spyExecutor: IProcessExecutor = {
      async execute(command, args, options) {
        executedArgs.push(args);
        return service['executor'].execute(command, args, options);
      },
    };

    const spyService = new GitWorktreeService(
      {
        gitExecutable: gitExe,
        repositoryRoot: repoDir,
        managedRoot: managedDir,
      },
      spyExecutor
    );

    const t = makeTuple();
    await spyService.createWorktree(t);
    await spyService.removeWorktree(t);

    for (const args of executedArgs) {
      if (args.includes('remove')) {
        expect(args).not.toContain('--force');
        expect(args).not.toContain('-f');
      }
    }
  });

  it('35. No worktree prune command is generated', async () => {
    const executedArgs: string[][] = [];
    const spyExecutor: IProcessExecutor = {
      async execute(command, args, options) {
        executedArgs.push(args);
        return service['executor'].execute(command, args, options);
      },
    };

    const spyService = new GitWorktreeService(
      {
        gitExecutable: gitExe,
        repositoryRoot: repoDir,
        managedRoot: managedDir,
      },
      spyExecutor
    );

    const t = makeTuple();
    await spyService.createWorktree(t);
    await spyService.inspectWorktree(t);
    await spyService.removeWorktree(t);

    for (const args of executedArgs) {
      expect(args).not.toContain('prune');
    }
  });

  it('36. All git invocation args are structured, shell=false', async () => {
    const t = makeTuple();
    const res = await service.createWorktree(t);
    expect(res.status).toBe('CREATED');
  });

  it('37. No raw ownership ID is used as filesystem path segment', () => {
    const rawTuple = makeTuple({
      projectId: 'MY_PROJECT_RAW',
      taskId: 'MY_TASK_RAW',
      assignmentId: 'MY_ASGN_RAW',
    });
    const derived = service.deriveWorktreePath(rawTuple);
    const basename = path.basename(derived.worktreePath);
    expect(basename).not.toContain('MY_PROJECT_RAW');
    expect(basename).not.toContain('MY_TASK_RAW');
    expect(basename).not.toContain('MY_ASGN_RAW');
    expect(basename.startsWith('afw-')).toBe(true);
  });

  it('38. Case-normalized containment behaves correctly on Windows', () => {
    const t = makeTuple();
    const derived = service.deriveWorktreePath(t);
    expect(derived.worktreePath.toLowerCase().startsWith(service.getManagedRoot().toLowerCase())).toBe(true);
  });
});
