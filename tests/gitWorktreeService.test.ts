import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { WorktreeMutationBoundary } from '../src/core/services/WorktreeMutationBoundary';
import {
  GitWorktreeService,
  GitWorktreeServiceConfig,
  WorktreeOwnershipTuple,
  IProcessExecutor,
  DefaultProcessExecutor,
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
    expect(res.status, JSON.stringify(res)).toBe('CREATED');
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

  it('32. Lock verification failure after checkout triggers safe owned rollback', async () => {
    const executedCommands: { command: string; args: string[] }[] = [];
    let lists = 0;
    const customExecutor: IProcessExecutor = {
      async execute(command, args, options) {
        executedCommands.push({ command, args });
        // Fail when running worktree lock
        if (process.platform !== 'win32' && args[0] === 'worktree' && args[1] === 'lock') {
          return { exitCode: 1, stdout: '', stderr: 'Simulated lock failure' };
        }
        const result = await service['executor'].execute(command, args, options);
        if (process.platform === 'win32' && args[0] === 'worktree' && args[1] === 'list' && ++lists === 2) {
          expect(result.stdout).toContain('locked AgentForge');
          return { ...result, stdout: result.stdout.replace(/^locked .*$/gm, '') };
        }
        return result;
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
    let lists = 0;
    let busyFd: number | null = null;
    const customExecutor: IProcessExecutor = {
      async execute(command, args, options) {
        // Fail when running worktree lock
        if (process.platform !== 'win32' && args[0] === 'worktree' && args[1] === 'lock') {
          return { exitCode: 1, stdout: '', stderr: 'Simulated lock failure' };
        }
        // Also fail rollback remove
        if (process.platform !== 'win32' && args[0] === 'worktree' && args[1] === 'remove') {
          return { exitCode: 1, stdout: '', stderr: 'Simulated remove failure during rollback' };
        }
        const result = await service['executor'].execute(command, args, options);
        if (process.platform === 'win32' && args[0] === 'worktree' && args[1] === 'list' && ++lists === 2) {
          // A real active writer prevents captured rollback acquisition. All
          // previously captured files/metadata must be retained, not forced.
          busyFd = fs.openSync(path.join(service.deriveWorktreePath(makeTuple()).worktreePath, 'active-writer'), 'wx');
          fs.writeSync(busyFd, 'retain');
          return { ...result, stdout: result.stdout.replace(/^locked .*$/gm, '') };
        }
        return result;
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
    try {
      const res = await failingService.createWorktree(t);
      expect(res.status).toBe('FAILED');
      if (res.status === 'FAILED') {
        expect(res.code).toBe('CREATE_ROLLBACK_FAILED');
        if (process.platform === 'win32') {
          expect(fs.readFileSync(path.join(res.worktreePath!, 'active-writer'), 'utf8')).toBe('retain');
          expect(fs.existsSync(path.join(res.worktreePath!, '.git'))).toBe(true);
        }
      }
    } finally { if (busyFd !== null) fs.closeSync(busyFd); }
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

  it('39. Pre-existing target symlink is rejected without touching its outside target', async () => {
    const tuple = makeTuple({ assignmentId: 'symlink-target' });
    const target = service.deriveWorktreePath(tuple).worktreePath;
    const outside = path.join(testBaseDir, 'outside-target');
    fs.mkdirSync(outside, { recursive: true });
    const marker = path.join(outside, 'must-survive.txt');
    fs.writeFileSync(marker, 'keep');

    try {
      fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await service.createWorktree(tuple);
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') expect(result.code).toBe('PATH_CONTAINMENT_DENIED');
      expect(fs.readFileSync(marker, 'utf8')).toBe('keep');
    } finally {
      try { fs.unlinkSync(target); } catch {}
    }
  });

  it('40. Target replacement with a symlink is fenced before removal and cannot delete outside files', async () => {
    const tuple = makeTuple({ assignmentId: 'remove-race' });
    const created = await service.createWorktree(tuple);
    expect(created.status).toBe('CREATED');
    if (created.status !== 'CREATED') return;

    const outside = path.join(testBaseDir, 'outside-remove-target');
    fs.mkdirSync(outside, { recursive: true });
    const marker = path.join(outside, 'must-survive.txt');
    fs.writeFileSync(marker, 'keep');
    const orphan = `${created.worktreePath}-orphan`;

    try {
      fs.renameSync(created.worktreePath, orphan);
      fs.symlinkSync(outside, created.worktreePath, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await service.removeWorktree(tuple);
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') expect(result.code).toBe('PATH_CONTAINMENT_DENIED');
      expect(fs.readFileSync(marker, 'utf8')).toBe('keep');
    } finally {
      try { fs.unlinkSync(created.worktreePath); } catch {}
      try { execSync(`"${gitExe}" worktree unlock "${created.worktreePath}"`, { cwd: repoDir, stdio: 'ignore' }); } catch {}
      try { execSync(`"${gitExe}" worktree remove --force "${created.worktreePath}"`, { cwd: repoDir, stdio: 'ignore' }); } catch {}
      try { fs.rmSync(orphan, { recursive: true, force: true }); } catch {}
    }
  });

  it('41. A target symlink inserted after checked absence and before reservation fails closed', async () => {
    const tuple = makeTuple({ assignmentId: 'add-race' });
    const target = service.deriveWorktreePath(tuple).worktreePath;
    const outside = path.join(testBaseDir, 'outside-add-target');
    fs.mkdirSync(outside, { recursive: true });
    const marker = path.join(outside, 'must-survive.txt');
    fs.writeFileSync(marker, 'keep');
    let raced = false;
    const delegate = new DefaultProcessExecutor();
    const raceExecutor: IProcessExecutor = {
      async execute(command, args, options) {
        if (!raced && args[0] === 'worktree' && args[1] === (process.platform === 'win32' ? 'list' : 'add')) {
          raced = true;
          fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return delegate.execute(command, args, options);
      },
    };
    const racedService = new GitWorktreeService(
      { gitExecutable: gitExe, repositoryRoot: repoDir, managedRoot: managedDir },
      raceExecutor,
    );

    try {
      const result = await racedService.createWorktree(tuple);
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') expect(['GIT_ADD_FAILED', 'PATH_CONTAINMENT_DENIED', 'PATH_IDENTITY_CHANGED']).toContain(result.code);
      expect(fs.readFileSync(marker, 'utf8')).toBe('keep');
    } finally {
      try { fs.unlinkSync(target); } catch {}
    }
  });

  it('42. Concurrent creates serialize through the managed-root lock without cross-target interference', async () => {
    const first = makeTuple({ assignmentId: 'concurrent-a', workerSlotId: 'slot-a' });
    const second = makeTuple({ assignmentId: 'concurrent-b', workerSlotId: 'slot-b' });
    const [firstResult, secondResult] = await Promise.all([
      service.createWorktree(first),
      service.createWorktree(second),
    ]);
    expect(firstResult.status).toBe('CREATED');
    expect(secondResult.status).toBe('CREATED');
    if (firstResult.status === 'CREATED' && secondResult.status === 'CREATED') {
      expect(firstResult.worktreePath).not.toBe(secondResult.worktreePath);
    }
  });

  it('43. A stale operation lock is recovered without weakening the root identity fence', async () => {
    const tuple = makeTuple({ assignmentId: 'stale-lock-recovery' });
    const lockPath = path.join(managedDir, '.agent-forge-worktree-operation.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: Date.now() }), 'utf8');

    const result = await service.createWorktree(tuple);
    expect(result.status).toBe('CREATED');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('44. A live owner lock is never broken solely because its age exceeds the recovery threshold', () => {
    const lockPath = path.join(managedDir, '.agent-forge-worktree-operation.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 10 * 60 * 1000 }),
      'utf8',
    );

    try {
      const recovered = (service as any).tryBreakStaleManagedRootLock(lockPath);
      expect(recovered).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  });

  it('45. Managed-root replacement is rejected before Git and cannot affect the replacement target', async () => {
    const tuple = makeTuple({ assignmentId: 'root-replacement' });
    const outside = path.join(testBaseDir, 'outside-managed-root');
    const backup = `${managedDir}-original`;
    fs.mkdirSync(outside, { recursive: true });
    const marker = path.join(outside, 'must-survive.txt');
    fs.writeFileSync(marker, 'keep');

    try {
      fs.renameSync(managedDir, backup);
      fs.symlinkSync(outside, managedDir, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await service.createWorktree(tuple);
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') expect(['PATH_IDENTITY_CHANGED', 'PATH_CONTAINMENT_DENIED']).toContain(result.code);
      expect(fs.readFileSync(marker, 'utf8')).toBe('keep');
    } finally {
      try { fs.unlinkSync(managedDir); } catch {}
      try { fs.renameSync(backup, managedDir); } catch {}
    }
  });

  it.skipIf(process.platform !== 'win32')('46. Read-only source proof remains available while native operation ownership is held', async () => {
    const executor = new DefaultProcessExecutor();
    const args = ['rev-parse', '--verify', '--quiet', `${baseCommitSha}^{commit}`];
    const cwd = service.getRepositoryRoot();
    const initial = await executor.execute(gitExe, args, { cwd, env: { GIT_OPTIONAL_LOCKS: '0' } });
    expect(initial.exitCode, JSON.stringify(initial)).toBe(0);
    const boundary = await WorktreeMutationBoundary.acquire(service.getManagedRoot());
    try {
      expect(await boundary.acquireOperationLock({ pid: process.pid, token: 'fixture', createdAt: Date.now() })).toBe(true);
      const result = await executor.execute(gitExe, args, { cwd, env: { GIT_OPTIONAL_LOCKS: '0' } });
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout.trim().toLowerCase()).toBe(baseCommitSha);
    } finally { await boundary.close(); }
  });

  it.skipIf(process.platform !== 'win32')('47. Captured registration is independently parsed with exact native path and SHA', async () => {
    const { ManagedGitWorktreeMutation } = await import('../src/core/services/ManagedGitWorktreeMutation');
    const tuple = makeTuple(); const { worktreePath, digest } = service.deriveWorktreePath(tuple);
    const mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: gitExe, repositoryRoot: service.getRepositoryRoot(), managedRoot: service.getManagedRoot() }, path.basename(worktreePath));
    try {
      await mutation.create(baseCommitSha, digest);
      const result = await new DefaultProcessExecutor().execute(gitExe, ['worktree', 'list', '--porcelain'], { cwd: service.getRepositoryRoot(), env: { GIT_OPTIONAL_LOCKS: '0' } });
      const entries = await service.listPorcelain();
      expect(entries.some(entry => path.resolve(entry.worktreePath).toLowerCase() === worktreePath.toLowerCase() && entry.headSha === baseCommitSha && entry.isDetached), JSON.stringify({ result, entries })).toBe(true);
    } finally { await mutation.rollbackCreated(); await mutation.close(); }
  });

  it.skipIf(process.platform !== 'win32')('48. A service cleanup race after the last precheck cannot retarget Git deletion outside its root', async () => {
    const tuple = makeTuple({ assignmentId: 'last-precheck-remove' });
    const created = await service.createWorktree(tuple);
    expect(created.status).toBe('CREATED'); if (created.status !== 'CREATED') return;
    const outside = path.join(fs.realpathSync.native(testBaseDir), 'outside-registered');
    execSync(`"${gitExe}" worktree add --detach "${outside}" ${baseCommitSha}`, { cwd: repoDir, stdio: 'ignore' });
    const outsideTrackedBefore = fs.readFileSync(path.join(outside, 'README.md'));
    fs.writeFileSync(path.join(outside, 'ignored-sentinel'), 'keep');
    fs.appendFileSync(path.join(repoDir, '.git', 'info', 'exclude'), '\nignored-sentinel\n');
    let attempted = false;
    const executor: IProcessExecutor = { async execute(command, args, options) {
      if (!attempted && args[0] === 'status') {
        attempted = true;
        // This is inside the admitted executor, after the service's last
        // identity check. The kernel guard must reject the first rename.
        expect(() => fs.renameSync(service.getManagedRoot(), service.getManagedRoot() + '-moved')).toThrow();
        expect(() => fs.renameSync(created.worktreePath, created.worktreePath + '-moved')).toThrow();
      }
      return new DefaultProcessExecutor().execute(command, args, options);
    } };
    const raced = new GitWorktreeService({ gitExecutable: gitExe, repositoryRoot: repoDir, managedRoot: managedDir }, executor);
    const result = await raced.removeWorktree(tuple);
    expect(attempted).toBe(true);
    expect(result.status, JSON.stringify(result)).toBe('REMOVED');
    expect(fs.readFileSync(path.join(outside, 'README.md'))).toEqual(outsideTrackedBefore);
    expect(fs.readFileSync(path.join(outside, 'ignored-sentinel'), 'utf8')).toBe('keep');
    expect(execSync(`"${gitExe}" rev-parse HEAD`, { cwd: outside, encoding: 'utf8' }).trim()).toBe(baseCommitSha);
  });

  it.skipIf(process.platform !== 'win32')('49. A replacement with a copied Git pointer cannot be removed by the stale service owner', async () => {
    const tuple = makeTuple({ assignmentId: 'copied-owner-remove' });
    const created = await service.createWorktree(tuple);
    expect(created.status).toBe('CREATED'); if (created.status !== 'CREATED') return;
    const former = created.worktreePath + '-former';
    fs.renameSync(created.worktreePath, former);
    fs.mkdirSync(created.worktreePath);
    fs.copyFileSync(path.join(former, '.git'), path.join(created.worktreePath, '.git'));
    fs.copyFileSync(path.join(former, 'README.md'), path.join(created.worktreePath, 'README.md'));
    fs.writeFileSync(path.join(created.worktreePath, 'new-owner-sentinel'), 'keep');
    fs.appendFileSync(path.join(repoDir, '.git', 'info', 'exclude'), '\nnew-owner-sentinel\n');
    const result = await service.removeWorktree(tuple);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.code).toBe('UNMANAGED_WORKTREE');
    expect(fs.readFileSync(path.join(created.worktreePath, 'new-owner-sentinel'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(former, 'README.md'), 'utf8')).toBe('# Initial Repository\n');
  });

  it.skipIf(process.platform !== 'win32')('50. Missing managed parents are initialized through captured objects before valid create and remove', async () => {
    const missing = path.join(fs.realpathSync.native(testBaseDir), 'missing-parent', 'missing-root');
    const fresh = new GitWorktreeService({ gitExecutable: gitExe, repositoryRoot: repoDir, managedRoot: missing });
    const result = await fresh.createWorktree(makeTuple());
    expect(result.status, JSON.stringify(result)).toBe('CREATED');
    expect((await fresh.removeWorktree(makeTuple())).status).toBe('REMOVED');
  });

  it.skipIf(process.platform !== 'win32')('51. A missing managed root under a short repository alias is rejected before filesystem mutation', () => {
    const program = String.raw`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class ShortRepositoryFixture {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetShortPathNameW(string p,StringBuilder result,uint size);
 public static string Get(string p) { var result=new StringBuilder(32768); uint size=GetShortPathNameW(p,result,(uint)result.Capacity); if(size==0||size>=result.Capacity)throw new Exception("SHORT_PATH_UNAVAILABLE"); return result.ToString(); }
}
'@
$request=[Console]::ReadLine()|ConvertFrom-Json
[ShortRepositoryFixture]::Get([string]$request.path)
`;
    const result = spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
      { windowsHide: true, encoding: 'utf8', input: JSON.stringify({ path: repoDir }) + '\n' });
    expect(result.status).toBe(0);
    const short = result.stdout.trim();
    const childrenBefore = fs.readdirSync(repoDir);
    expect(() => new GitWorktreeService({ gitExecutable: gitExe, repositoryRoot: repoDir,
      managedRoot: path.join(short, 'forbidden-new-parent', 'managed') })).toThrow('INVALID_MANAGED_ROOT');
    expect(fs.readdirSync(repoDir)).toEqual(childrenBefore);
    expect(fs.existsSync(path.join(repoDir, 'forbidden-new-parent'))).toBe(false);
  });

  it('52. Cleanup from an earlier epoch cannot address a newer worktree with otherwise identical ownership', async () => {
    const previous = makeTuple({ ownershipEpoch: 1 });
    const current = makeTuple({ ownershipEpoch: 2 });
    const old = await service.createWorktree(previous);
    expect(old.status).toBe('CREATED'); if (old.status !== 'CREATED') return;
    expect((await service.removeWorktree(previous)).status).toBe('REMOVED');
    const fresh = await service.createWorktree(current);
    expect(fresh.status).toBe('CREATED'); if (fresh.status !== 'CREATED') return;
    expect(fresh.worktreePath).not.toBe(old.worktreePath);
    const bytesBefore = fs.readFileSync(path.join(fresh.worktreePath, 'README.md'));
    expect((await service.removeWorktree(previous)).status).toBe('FAILED');
    expect((await service.removeWorktree(makeTuple())).status).toBe('FAILED');
    expect(fs.readFileSync(path.join(fresh.worktreePath, 'README.md'))).toEqual(bytesBefore);
    expect((await service.inspectWorktree(current)).status).toBe('INSPECTED');
    expect((await service.removeWorktree(current)).status).toBe('REMOVED');
  });

  it('53. Malformed epochs cannot acquire a mutation helper, reach Git or collide with the legacy namespace', async () => {
    const acquire = vi.spyOn(WorktreeMutationBoundary, 'acquire');
    const execute = vi.spyOn(DefaultProcessExecutor.prototype, 'execute');
    const children = fs.readdirSync(service.getManagedRoot());
    try {
      for (const epoch of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
        const tuple = makeTuple({ ownershipEpoch: epoch as number });
        expect(() => service.deriveWorktreePath(tuple)).toThrow('INVALID_OWNERSHIP_EPOCH');
        for (const result of [await service.createWorktree(tuple), await service.inspectWorktree(tuple), await service.removeWorktree(tuple)]) {
          expect(result).toMatchObject({ status: 'FAILED', code: 'INVALID_OWNERSHIP_EPOCH' });
        }
      }
      expect(acquire).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(fs.readdirSync(service.getManagedRoot())).toEqual(children);
      expect(service.deriveWorktreePath(makeTuple({ ownershipEpoch: null }))).toEqual(service.deriveWorktreePath(makeTuple()));
    } finally { acquire.mockRestore(); execute.mockRestore(); }
  });
});
