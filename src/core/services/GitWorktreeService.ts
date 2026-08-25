import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ProcessRunner } from './ProcessRunner';

export interface GitWorktreeServiceConfig {
  gitExecutable: string;
  repositoryRoot: string;
  managedRoot: string;
}

export interface IProcessExecutor {
  execute(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class DefaultProcessExecutor implements IProcessExecutor {
  public async execute(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const res = await ProcessRunner.execute({
      executable: command,
      args,
      cwd: options?.cwd ?? process.cwd(),
      timeoutMs: options?.timeoutMs ?? 30000,
      allowShell: false,
      env: options?.env,
    });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }
}

export interface WorktreeOwnershipTuple {
  projectId: string;
  taskId: string;
  attemptId?: string | null;
  assignmentId: string;
  workerSlotId: string;
  baseSha: string;
}

export type WorktreeErrorCode =
  | 'INVALID_GIT_EXECUTABLE'
  | 'INVALID_REPOSITORY_ROOT'
  | 'INVALID_MANAGED_ROOT'
  | 'INVALID_SOURCE_SHA'
  | 'SOURCE_COMMIT_NOT_FOUND'
  | 'WORKTREE_ALREADY_EXISTS'
  | 'WORKTREE_ALREADY_REGISTERED'
  | 'PATH_CONTAINMENT_DENIED'
  | 'GIT_ADD_FAILED'
  | 'HEAD_BINDING_MISMATCH'
  | 'WORKTREE_REGISTRATION_MISMATCH'
  | 'WORKTREE_LOCK_FAILED'
  | 'CREATE_ROLLBACK_FAILED'
  | 'UNMANAGED_WORKTREE'
  | 'DIRTY_WORKTREE'
  | 'HEAD_CHANGED'
  | 'REMOVE_FAILED'
  | 'INSPECTION_FAILED';

export interface WorktreeCreateSuccess {
  status: 'CREATED';
  worktreePath: string;
  baseSha: string;
  ownershipDigest: string;
}

export interface WorktreeFailure {
  status: 'FAILED';
  code: WorktreeErrorCode;
  error: string;
  worktreePath?: string;
}

export type WorktreeCreateResult = WorktreeCreateSuccess | WorktreeFailure;

export interface WorktreeInspection {
  managedPath: string;
  registered: boolean;
  exists: boolean;
  headSha: string | null;
  detached: boolean;
  locked: boolean;
  clean: boolean;
  ownershipDigest: string;
  sourceMatch: boolean;
}

export interface WorktreeInspectSuccess {
  status: 'INSPECTED';
  inspection: WorktreeInspection;
}

export type WorktreeInspectResult = WorktreeInspectSuccess | WorktreeFailure;

export interface WorktreeRemoveSuccess {
  status: 'REMOVED';
  worktreePath: string;
  ownershipDigest: string;
}

export type WorktreeRemoveResult = WorktreeRemoveSuccess | WorktreeFailure;

export interface PorcelainWorktreeEntry {
  worktreePath: string;
  headSha: string;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isPrunable: boolean;
}

function canonicalizePath(p: string): string {
  try {
    if (fs.existsSync(p)) {
      return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
    }
  } catch {}
  return path.resolve(p);
}

function normalizePathForComparison(p: string): string {
  const canonical = canonicalizePath(p);
  const resolved = path.resolve(canonical);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithinRoot(childPath: string, rootPath: string): boolean {
  const normChild = normalizePathForComparison(childPath);
  const normRoot = normalizePathForComparison(rootPath);
  if (normChild === normRoot) return false;
  const rel = path.relative(normRoot, normChild);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class GitWorktreeService {
  private gitExecutable: string;
  private canonicalRepoRoot: string;
  private canonicalManagedRoot: string;
  private executor: IProcessExecutor;

  constructor(config: GitWorktreeServiceConfig, executor?: IProcessExecutor) {
    this.executor = executor ?? new DefaultProcessExecutor();

    // 1. Validate Git Executable
    if (!config.gitExecutable || typeof config.gitExecutable !== 'string') {
      throw new Error('INVALID_GIT_EXECUTABLE: gitExecutable must be a non-empty string.');
    }
    if (!path.isAbsolute(config.gitExecutable)) {
      throw new Error(`INVALID_GIT_EXECUTABLE: gitExecutable must be an absolute path (received "${config.gitExecutable}"). Bare "git" is forbidden.`);
    }
    if (/[\r\n\0\t]/.test(config.gitExecutable)) {
      throw new Error('INVALID_GIT_EXECUTABLE: gitExecutable contains forbidden control characters.');
    }
    if (!fs.existsSync(config.gitExecutable)) {
      throw new Error(`INVALID_GIT_EXECUTABLE: gitExecutable "${config.gitExecutable}" does not exist.`);
    }
    const exeStat = fs.statSync(config.gitExecutable);
    if (!exeStat.isFile()) {
      throw new Error(`INVALID_GIT_EXECUTABLE: gitExecutable "${config.gitExecutable}" is not a regular file.`);
    }
    const exeBase = path.basename(config.gitExecutable).toLowerCase();
    if (exeBase !== 'git' && exeBase !== 'git.exe') {
      throw new Error(`INVALID_GIT_EXECUTABLE: gitExecutable basename must be "git" or "git.exe" (received "${exeBase}").`);
    }
    this.gitExecutable = path.resolve(config.gitExecutable);

    // 2. Validate Repository Root
    if (!config.repositoryRoot || typeof config.repositoryRoot !== 'string') {
      throw new Error('INVALID_REPOSITORY_ROOT: repositoryRoot must be a non-empty string.');
    }
    if (!path.isAbsolute(config.repositoryRoot)) {
      throw new Error(`INVALID_REPOSITORY_ROOT: repositoryRoot must be an absolute path (received "${config.repositoryRoot}").`);
    }
    if (!fs.existsSync(config.repositoryRoot) || !fs.statSync(config.repositoryRoot).isDirectory()) {
      throw new Error(`INVALID_REPOSITORY_ROOT: repositoryRoot "${config.repositoryRoot}" is not an existing directory.`);
    }
    this.canonicalRepoRoot = fs.realpathSync.native ? fs.realpathSync.native(config.repositoryRoot) : fs.realpathSync(config.repositoryRoot);

    // 3. Validate Managed Root
    if (!config.managedRoot || typeof config.managedRoot !== 'string') {
      throw new Error('INVALID_MANAGED_ROOT: managedRoot must be a non-empty string.');
    }
    if (!path.isAbsolute(config.managedRoot)) {
      throw new Error(`INVALID_MANAGED_ROOT: managedRoot must be an absolute path (received "${config.managedRoot}").`);
    }

    const normManaged = normalizePathForComparison(config.managedRoot);
    const sensitiveBases = ['.git', '.ssh', '.aws', '.gnupg', '.env', 'system32', 'windows'];
    const segments = normManaged.split(/[/\\]+/).map((s) => s.toLowerCase());
    if (segments.some((seg) => sensitiveBases.includes(seg))) {
      throw new Error(`INVALID_MANAGED_ROOT: managedRoot "${config.managedRoot}" targets a sensitive path.`);
    }

    if (!fs.existsSync(config.managedRoot)) {
      fs.mkdirSync(config.managedRoot, { recursive: true });
    }
    this.canonicalManagedRoot = fs.realpathSync.native ? fs.realpathSync.native(config.managedRoot) : fs.realpathSync(config.managedRoot);

    // 4. Validate Disjointness of Roots
    const normRepo = normalizePathForComparison(this.canonicalRepoRoot);
    const normMan = normalizePathForComparison(this.canonicalManagedRoot);

    if (normRepo === normMan) {
      throw new Error('INVALID_MANAGED_ROOT: managedRoot cannot be identical to repositoryRoot.');
    }
    if (isPathWithinRoot(this.canonicalManagedRoot, this.canonicalRepoRoot)) {
      throw new Error('INVALID_MANAGED_ROOT: managedRoot cannot reside inside repositoryRoot.');
    }
    if (isPathWithinRoot(this.canonicalRepoRoot, this.canonicalManagedRoot)) {
      throw new Error('INVALID_REPOSITORY_ROOT: repositoryRoot cannot reside inside managedRoot.');
    }
  }

  public getRepositoryRoot(): string {
    return this.canonicalRepoRoot;
  }

  public getManagedRoot(): string {
    return this.canonicalManagedRoot;
  }

  public getGitExecutable(): string {
    return this.gitExecutable;
  }

  /**
   * Derives a deterministic ownership digest and isolated filesystem path from an ownership tuple.
   */
  public deriveWorktreePath(tuple: WorktreeOwnershipTuple): { worktreePath: string; digest: string } {
    const canonicalJson = JSON.stringify({
      projectId: tuple.projectId,
      taskId: tuple.taskId,
      attemptId: tuple.attemptId ?? null,
      assignmentId: tuple.assignmentId,
      workerSlotId: tuple.workerSlotId,
      baseSha: tuple.baseSha.toLowerCase(),
    });
    const digest = crypto.createHash('sha256').update(canonicalJson).digest('hex');
    const worktreeDirName = `afw-${digest.substring(0, 32)}`;
    const derivedPath = path.resolve(this.canonicalManagedRoot, worktreeDirName);

    if (!isPathWithinRoot(derivedPath, this.canonicalManagedRoot)) {
      throw new Error(`PATH_CONTAINMENT_DENIED: Derived path "${derivedPath}" is not within managed root.`);
    }

    return { worktreePath: derivedPath, digest };
  }

  /**
   * Asynchronously creates an isolated, detached, locked Git worktree for an assignment.
   */
  public async createWorktree(tuple: WorktreeOwnershipTuple): Promise<WorktreeCreateResult> {
    // 1. Validate Base SHA syntax
    if (!tuple.baseSha || typeof tuple.baseSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(tuple.baseSha)) {
      return {
        status: 'FAILED',
        code: 'INVALID_SOURCE_SHA',
        error: `INVALID_SOURCE_SHA: baseSha "${tuple.baseSha}" must be a 40-character hexadecimal string.`,
      };
    }
    const expectedSha = tuple.baseSha.toLowerCase();

    // 2. Prove exact source commit exists in repository
    const commitCheck = await this.executor.execute(
      this.gitExecutable,
      ['rev-parse', '--verify', '--quiet', `${expectedSha}^{commit}`],
      { cwd: this.canonicalRepoRoot }
    );
    if (commitCheck.exitCode !== 0) {
      return {
        status: 'FAILED',
        code: 'SOURCE_COMMIT_NOT_FOUND',
        error: `SOURCE_COMMIT_NOT_FOUND: Source commit "${expectedSha}" does not exist in repository.`,
      };
    }

    // 3. Derive deterministic target path
    let targetPath: string;
    let digest: string;
    try {
      const derived = this.deriveWorktreePath(tuple);
      targetPath = derived.worktreePath;
      digest = derived.digest;
    } catch (err: any) {
      return {
        status: 'FAILED',
        code: 'PATH_CONTAINMENT_DENIED',
        error: `PATH_CONTAINMENT_DENIED: ${err.message}`,
      };
    }

    // 4. Verify path does not exist on filesystem
    if (fs.existsSync(targetPath)) {
      return {
        status: 'FAILED',
        code: 'WORKTREE_ALREADY_EXISTS',
        error: `WORKTREE_ALREADY_EXISTS: Target directory "${targetPath}" already exists on filesystem.`,
        worktreePath: targetPath,
      };
    }

    // 5. Verify path is not already registered in git worktree list
    const porcelainList = await this.listPorcelain();
    const isRegistered = porcelainList.some(
      (entry) => normalizePathForComparison(entry.worktreePath) === normalizePathForComparison(targetPath)
    );
    if (isRegistered) {
      return {
        status: 'FAILED',
        code: 'WORKTREE_ALREADY_REGISTERED',
        error: `WORKTREE_ALREADY_REGISTERED: Path "${targetPath}" is already registered in git worktree list.`,
        worktreePath: targetPath,
      };
    }

    // 6. Run git worktree add --detach <targetPath> <baseSha>
    const addResult = await this.executor.execute(
      this.gitExecutable,
      ['worktree', 'add', '--detach', targetPath, expectedSha],
      { cwd: this.canonicalRepoRoot }
    );
    if (addResult.exitCode !== 0) {
      return {
        status: 'FAILED',
        code: 'GIT_ADD_FAILED',
        error: `GIT_ADD_FAILED: "git worktree add" exited with code ${addResult.exitCode}: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
        worktreePath: targetPath,
      };
    }

    // 7. Post-Create Verification inside new worktree
    let rollbackNeeded = false;
    let failureCode: WorktreeErrorCode = 'HEAD_BINDING_MISMATCH';
    let failureMessage = '';

    try {
      // Verify HEAD equals expected baseSha
      const headCheck = await this.executor.execute(
        this.gitExecutable,
        ['rev-parse', 'HEAD'],
        { cwd: targetPath }
      );
      if (headCheck.exitCode !== 0 || headCheck.stdout.trim().toLowerCase() !== expectedSha) {
        rollbackNeeded = true;
        failureCode = 'HEAD_BINDING_MISMATCH';
        failureMessage = `HEAD_BINDING_MISMATCH: Checked out HEAD "${headCheck.stdout.trim()}" does not match expected "${expectedSha}".`;
      }

      // Verify detached state
      if (!rollbackNeeded) {
        const branchCheck = await this.executor.execute(
          this.gitExecutable,
          ['branch', '--show-current'],
          { cwd: targetPath }
        );
        if (branchCheck.exitCode !== 0 || branchCheck.stdout.trim() !== '') {
          rollbackNeeded = true;
          failureCode = 'HEAD_BINDING_MISMATCH';
          failureMessage = `HEAD_BINDING_MISMATCH: Worktree is attached to branch "${branchCheck.stdout.trim()}", expected detached HEAD.`;
        }
      }

      // Verify toplevel matches targetPath
      if (!rollbackNeeded) {
        const toplevelCheck = await this.executor.execute(
          this.gitExecutable,
          ['rev-parse', '--show-toplevel'],
          { cwd: targetPath }
        );
        if (
          toplevelCheck.exitCode !== 0 ||
          normalizePathForComparison(toplevelCheck.stdout.trim()) !== normalizePathForComparison(targetPath)
        ) {
          rollbackNeeded = true;
          failureCode = 'HEAD_BINDING_MISMATCH';
          failureMessage = `HEAD_BINDING_MISMATCH: Show toplevel "${toplevelCheck.stdout.trim()}" does not match "${targetPath}".`;
        }
      }

      // Verify registration in primary repository porcelain list
      if (!rollbackNeeded) {
        const postPorcelain = await this.listPorcelain();
        const matching = postPorcelain.filter(
          (entry) => normalizePathForComparison(entry.worktreePath) === normalizePathForComparison(targetPath)
        );
        if (
          matching.length !== 1 ||
          matching[0].headSha.toLowerCase() !== expectedSha ||
          !matching[0].isDetached
        ) {
          rollbackNeeded = true;
          failureCode = 'WORKTREE_REGISTRATION_MISMATCH';
          failureMessage = `WORKTREE_REGISTRATION_MISMATCH: Registration verification failed in git porcelain list.`;
        }
      }

      // Lock worktree
      if (!rollbackNeeded) {
        const lockReason = `AgentForge managed assignment ${digest.substring(0, 16)}`;
        const lockResult = await this.executor.execute(
          this.gitExecutable,
          ['worktree', 'lock', '--reason', lockReason, targetPath],
          { cwd: this.canonicalRepoRoot }
        );
        if (lockResult.exitCode !== 0) {
          rollbackNeeded = true;
          failureCode = 'WORKTREE_LOCK_FAILED';
          failureMessage = `WORKTREE_LOCK_FAILED: "git worktree lock" exited with code ${lockResult.exitCode}: ${lockResult.stderr.trim()}`;
        }
      }

      // Verify locked state in porcelain list
      if (!rollbackNeeded) {
        const postLockPorcelain = await this.listPorcelain();
        const matchingLocked = postLockPorcelain.find(
          (entry) => normalizePathForComparison(entry.worktreePath) === normalizePathForComparison(targetPath)
        );
        if (!matchingLocked || !matchingLocked.isLocked) {
          rollbackNeeded = true;
          failureCode = 'WORKTREE_LOCK_FAILED';
          failureMessage = `WORKTREE_LOCK_FAILED: Worktree does not appear locked in porcelain list after locking.`;
        }
      }
    } catch (err: any) {
      rollbackNeeded = true;
      failureCode = 'GIT_ADD_FAILED';
      failureMessage = `GIT_ADD_FAILED: Post-creation verification threw exception: ${err.message}`;
    }

    // 8. Execute rollback if verification or lock failed
    if (rollbackNeeded) {
      const rollbackSuccess = await this.attemptRollback(targetPath);
      if (!rollbackSuccess) {
        return {
          status: 'FAILED',
          code: 'CREATE_ROLLBACK_FAILED',
          error: `CREATE_ROLLBACK_FAILED: Initial failure (${failureCode}: ${failureMessage}) was followed by a failed rollback of "${targetPath}". Manual recovery required.`,
          worktreePath: targetPath,
        };
      }
      return {
        status: 'FAILED',
        code: failureCode,
        error: failureMessage,
        worktreePath: targetPath,
      };
    }

    return {
      status: 'CREATED',
      worktreePath: targetPath,
      baseSha: expectedSha,
      ownershipDigest: digest,
    };
  }

  /**
   * Inspects a managed worktree without mutating any filesystem or Git state.
   */
  public async inspectWorktree(tuple: WorktreeOwnershipTuple): Promise<WorktreeInspectResult> {
    let targetPath: string;
    let digest: string;
    try {
      const derived = this.deriveWorktreePath(tuple);
      targetPath = derived.worktreePath;
      digest = derived.digest;
    } catch (err: any) {
      return {
        status: 'FAILED',
        code: 'PATH_CONTAINMENT_DENIED',
        error: `PATH_CONTAINMENT_DENIED: ${err.message}`,
      };
    }

    const exists = fs.existsSync(targetPath);
    const porcelainList = await this.listPorcelain();
    const entry = porcelainList.find(
      (e) => normalizePathForComparison(e.worktreePath) === normalizePathForComparison(targetPath)
    );
    const registered = !!entry;

    let headSha: string | null = entry?.headSha ? entry.headSha.toLowerCase() : null;
    let detached = entry?.isDetached ?? false;
    let locked = entry?.isLocked ?? false;
    let clean = false;
    const expectedSha = tuple.baseSha.toLowerCase();

    if (exists && registered) {
      try {
        const headCheck = await this.executor.execute(this.gitExecutable, ['rev-parse', 'HEAD'], { cwd: targetPath });
        if (headCheck.exitCode === 0) {
          headSha = headCheck.stdout.trim().toLowerCase();
        }
        const branchCheck = await this.executor.execute(this.gitExecutable, ['branch', '--show-current'], { cwd: targetPath });
        if (branchCheck.exitCode === 0) {
          detached = branchCheck.stdout.trim() === '';
        }
        const statusCheck = await this.executor.execute(
          this.gitExecutable,
          ['status', '--porcelain', '-uall'],
          { cwd: targetPath }
        );
        if (statusCheck.exitCode === 0) {
          clean = statusCheck.stdout.trim() === '';
        }
      } catch {
        clean = false;
      }
    }

    const sourceMatch = headSha === expectedSha;

    return {
      status: 'INSPECTED',
      inspection: {
        managedPath: targetPath,
        registered,
        exists,
        headSha,
        detached,
        locked,
        clean,
        ownershipDigest: digest,
        sourceMatch,
      },
    };
  }

  /**
   * Safely removes an un-modified, clean, detached managed Git worktree.
   */
  public async removeWorktree(tuple: WorktreeOwnershipTuple): Promise<WorktreeRemoveResult> {
    let targetPath: string;
    let digest: string;
    try {
      const derived = this.deriveWorktreePath(tuple);
      targetPath = derived.worktreePath;
      digest = derived.digest;
    } catch (err: any) {
      return {
        status: 'FAILED',
        code: 'PATH_CONTAINMENT_DENIED',
        error: `PATH_CONTAINMENT_DENIED: ${err.message}`,
      };
    }

    // Prohibit removal of primary repository root
    if (normalizePathForComparison(targetPath) === normalizePathForComparison(this.canonicalRepoRoot)) {
      return {
        status: 'FAILED',
        code: 'UNMANAGED_WORKTREE',
        error: `UNMANAGED_WORKTREE: Removal of primary repository root "${this.canonicalRepoRoot}" is forbidden.`,
        worktreePath: targetPath,
      };
    }

    // Check directory existence
    if (!fs.existsSync(targetPath)) {
      return {
        status: 'FAILED',
        code: 'UNMANAGED_WORKTREE',
        error: `UNMANAGED_WORKTREE: Target worktree directory "${targetPath}" does not exist on filesystem.`,
        worktreePath: targetPath,
      };
    }

    // Check registration in porcelain list
    const porcelainList = await this.listPorcelain();
    const entry = porcelainList.find(
      (e) => normalizePathForComparison(e.worktreePath) === normalizePathForComparison(targetPath)
    );
    if (!entry) {
      return {
        status: 'FAILED',
        code: 'UNMANAGED_WORKTREE',
        error: `UNMANAGED_WORKTREE: Target worktree "${targetPath}" is not registered with Git repository.`,
        worktreePath: targetPath,
      };
    }

    // Check HEAD matches expected baseSha
    const headCheck = await this.executor.execute(this.gitExecutable, ['rev-parse', 'HEAD'], { cwd: targetPath });
    const expectedSha = tuple.baseSha.toLowerCase();
    if (headCheck.exitCode !== 0 || headCheck.stdout.trim().toLowerCase() !== expectedSha) {
      return {
        status: 'FAILED',
        code: 'HEAD_CHANGED',
        error: `HEAD_CHANGED: Worktree HEAD ("${headCheck.stdout.trim()}") does not match expected baseSha "${expectedSha}". Removal denied.`,
        worktreePath: targetPath,
      };
    }

    // Check working directory clean status
    const statusCheck = await this.executor.execute(
      this.gitExecutable,
      ['status', '--porcelain', '-uall'],
      { cwd: targetPath }
    );
    if (statusCheck.exitCode !== 0 || statusCheck.stdout.trim() !== '') {
      return {
        status: 'FAILED',
        code: 'DIRTY_WORKTREE',
        error: `DIRTY_WORKTREE: Worktree "${targetPath}" has uncommitted or untracked changes. Removal denied.`,
        worktreePath: targetPath,
      };
    }

    // 1. Unlock worktree if locked
    if (entry.isLocked) {
      const unlockResult = await this.executor.execute(
        this.gitExecutable,
        ['worktree', 'unlock', targetPath],
        { cwd: this.canonicalRepoRoot }
      );
      if (unlockResult.exitCode !== 0) {
        return {
          status: 'FAILED',
          code: 'REMOVE_FAILED',
          error: `REMOVE_FAILED: Failed to unlock worktree "${targetPath}": ${unlockResult.stderr.trim()}`,
          worktreePath: targetPath,
        };
      }
    }

    // 2. Remove worktree (WITHOUT --force)
    const removeResult = await this.executor.execute(
      this.gitExecutable,
      ['worktree', 'remove', targetPath],
      { cwd: this.canonicalRepoRoot }
    );
    if (removeResult.exitCode !== 0) {
      // Attempt to re-lock on remove failure to protect worktree
      try {
        await this.executor.execute(
          this.gitExecutable,
          ['worktree', 'lock', '--reason', `AgentForge managed assignment ${digest.substring(0, 16)}`, targetPath],
          { cwd: this.canonicalRepoRoot }
        );
      } catch {
        // ignore re-lock failure in error handler
      }
      return {
        status: 'FAILED',
        code: 'REMOVE_FAILED',
        error: `REMOVE_FAILED: "git worktree remove" exited with code ${removeResult.exitCode}: ${removeResult.stderr.trim()}`,
        worktreePath: targetPath,
      };
    }

    // 3. Verify path is no longer registered
    const postRemovePorcelain = await this.listPorcelain();
    const stillRegistered = postRemovePorcelain.some(
      (e) => normalizePathForComparison(e.worktreePath) === normalizePathForComparison(targetPath)
    );
    if (stillRegistered || fs.existsSync(targetPath)) {
      return {
        status: 'FAILED',
        code: 'REMOVE_FAILED',
        error: `REMOVE_FAILED: Worktree "${targetPath}" remains registered or present after removal.`,
        worktreePath: targetPath,
      };
    }

    return {
      status: 'REMOVED',
      worktreePath: targetPath,
      ownershipDigest: digest,
    };
  }

  /**
   * Internal rollback helper for failed creation attempts.
   */
  private async attemptRollback(worktreePath: string): Promise<boolean> {
    try {
      await this.executor.execute(this.gitExecutable, ['worktree', 'unlock', worktreePath], {
        cwd: this.canonicalRepoRoot,
      });
      const removeResult = await this.executor.execute(
        this.gitExecutable,
        ['worktree', 'remove', worktreePath],
        { cwd: this.canonicalRepoRoot }
      );
      if (removeResult.exitCode !== 0) return false;
      const list = await this.listPorcelain();
      const stillRegistered = list.some(
        (e) => normalizePathForComparison(e.worktreePath) === normalizePathForComparison(worktreePath)
      );
      return !stillRegistered && !fs.existsSync(worktreePath);
    } catch {
      return false;
    }
  }

  /**
   * Parses git worktree list --porcelain from repository root.
   */
  public async listPorcelain(): Promise<PorcelainWorktreeEntry[]> {
    const res = await this.executor.execute(
      this.gitExecutable,
      ['worktree', 'list', '--porcelain'],
      { cwd: this.canonicalRepoRoot }
    );
    if (res.exitCode !== 0) {
      throw new Error(`Failed to list git worktrees: ${res.stderr.trim()}`);
    }

    const entries: PorcelainWorktreeEntry[] = [];
    const lines = res.stdout.split(/\r?\n/);
    let current: Partial<PorcelainWorktreeEntry> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current && current.worktreePath) {
          entries.push({
            worktreePath: current.worktreePath,
            headSha: current.headSha ?? '',
            branch: current.branch ?? null,
            isDetached: current.isDetached ?? false,
            isLocked: current.isLocked ?? false,
            lockReason: current.lockReason ?? null,
            isPrunable: current.isPrunable ?? false,
          });
        }
        current = null;
        continue;
      }

      if (trimmed.startsWith('worktree ')) {
        if (current && current.worktreePath) {
          entries.push({
            worktreePath: current.worktreePath,
            headSha: current.headSha ?? '',
            branch: current.branch ?? null,
            isDetached: current.isDetached ?? false,
            isLocked: current.isLocked ?? false,
            lockReason: current.lockReason ?? null,
            isPrunable: current.isPrunable ?? false,
          });
        }
        current = {
          worktreePath: trimmed.substring(9).trim(),
          isDetached: false,
          isLocked: false,
          isPrunable: false,
        };
      } else if (trimmed.startsWith('HEAD ') && current) {
        current.headSha = trimmed.substring(5).trim();
      } else if (trimmed.startsWith('branch ') && current) {
        current.branch = trimmed.substring(7).trim();
      } else if (trimmed === 'detached' && current) {
        current.isDetached = true;
      } else if (trimmed.startsWith('locked') && current) {
        current.isLocked = true;
        const rest = trimmed.substring(6).trim();
        current.lockReason = rest.length > 0 ? rest : null;
      } else if (trimmed.startsWith('prunable') && current) {
        current.isPrunable = true;
      }
    }

    if (current && current.worktreePath) {
      entries.push({
        worktreePath: current.worktreePath,
        headSha: current.headSha ?? '',
        branch: current.branch ?? null,
        isDetached: current.isDetached ?? false,
        isLocked: current.isLocked ?? false,
        lockReason: current.lockReason ?? null,
        isPrunable: current.isPrunable ?? false,
      });
    }

    return entries;
  }
}
