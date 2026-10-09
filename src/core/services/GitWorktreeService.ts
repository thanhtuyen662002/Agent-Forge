import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ProcessRunner } from './ProcessRunner';
import { WorktreeMutationBoundary } from './WorktreeMutationBoundary';
import { ManagedGitWorktreeMutation } from './ManagedGitWorktreeMutation';

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
      allowedEnvKeys: ['GIT_OPTIONAL_LOCKS'],
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
  ownershipEpoch?: number | null;
}

export type WorktreeErrorCode =
  | 'INVALID_GIT_EXECUTABLE'
  | 'INVALID_REPOSITORY_ROOT'
  | 'INVALID_MANAGED_ROOT'
  | 'INVALID_SOURCE_SHA'
  | 'INVALID_OWNERSHIP_EPOCH'
  | 'SOURCE_COMMIT_NOT_FOUND'
  | 'WORKTREE_ALREADY_EXISTS'
  | 'WORKTREE_ALREADY_REGISTERED'
  | 'PATH_CONTAINMENT_DENIED'
  | 'PATH_IDENTITY_CHANGED'
  | 'GIT_ADD_FAILED'
  | 'HEAD_BINDING_MISMATCH'
  | 'WORKTREE_REGISTRATION_MISMATCH'
  | 'WORKTREE_LOCK_FAILED'
  | 'CREATE_ROLLBACK_FAILED'
  | 'UNMANAGED_WORKTREE'
  | 'DIRTY_WORKTREE'
  | 'HEAD_CHANGED'
  | 'UNSUPPORTED_MUTATION_BOUNDARY'
  | 'UNSUPPORTED_GIT_LAYOUT'
  | 'PARTIAL_WORKTREE_SETUP'
  | 'UNSUPPORTED_CHECKOUT_ENTRY'
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

interface DirectoryIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

class PathIdentityError extends Error {
  public readonly code: 'PATH_CONTAINMENT_DENIED' | 'PATH_IDENTITY_CHANGED';

  constructor(code: 'PATH_CONTAINMENT_DENIED' | 'PATH_IDENTITY_CHANGED', message: string) {
    super(message);
    this.name = 'PathIdentityError';
    this.code = code;
  }
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

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  if (normalizePathForComparison(left.realPath) !== normalizePathForComparison(right.realPath)) return false;
  // Preserve exact IDs. Windows st_dev can be zero; native mutation separately
  // anchors a nonzero kernel volume. A missing inode never becomes a fallback.
  return left.ino !== 0n && right.ino !== 0n && left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function isMissingFsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class GitWorktreeService {
  private static readonly OPERATION_LOCK_TIMEOUT_MS = 30_000;
  private static readonly OPERATION_LOCK_RETRY_MS = 25;

  private gitExecutable: string;
  private canonicalRepoRoot: string;
  private canonicalManagedRoot: string;
  private repositoryRootIdentity: DirectoryIdentity;
  private managedRootIdentity: DirectoryIdentity;
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
    this.repositoryRootIdentity = this.captureDirectoryIdentity(this.canonicalRepoRoot, 'repository root');

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

    this.canonicalManagedRoot = path.resolve(config.managedRoot);
    if (process.platform === 'win32') {
      // Windows TEMP may contain a genuine 8.3 spelling. Expand that spelling
      // only when every ordinary parent and the exact BigInt leaf identity
      // agree. Junctions are denied, and this read-only normalization performs
      // no filesystem mutation. Native guards capture the canonical objects.
      let anchor = this.canonicalManagedRoot;
      while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
      const original = fs.lstatSync(anchor, { bigint: true });
      let current = path.parse(anchor).root;
      for (const segment of anchor.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const parent = fs.lstatSync(current, { bigint: true });
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('INVALID_MANAGED_ROOT: Reparse parent or alias is denied.');
      }
      const canonical = fs.realpathSync.native(anchor);
      const captured = fs.lstatSync(canonical, { bigint: true });
      if (!original.isDirectory() || original.isSymbolicLink() || original.ino === 0n || original.ino !== captured.ino ||
          original.dev !== captured.dev || original.birthtimeNs !== captured.birthtimeNs) throw new Error('INVALID_MANAGED_ROOT: Alias identity changed.');
      this.canonicalManagedRoot = path.join(canonical, path.relative(anchor, this.canonicalManagedRoot));
      if (this.canonicalManagedRoot.split(/[/\\]+/).some(segment => sensitiveBases.includes(segment.toLowerCase()))) {
        throw new Error('INVALID_MANAGED_ROOT: Canonical managed root targets a sensitive path.');
      }
    }

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
    if (!fs.existsSync(this.canonicalManagedRoot)) {
      if (process.platform === 'win32') {
        try { this.canonicalManagedRoot = WorktreeMutationBoundary.initializeSync(this.canonicalManagedRoot).root; }
        catch { throw new Error('INVALID_MANAGED_ROOT: Captured parent initialization was denied.'); }
      } else {
        throw new Error('UNSUPPORTED_MUTATION_BOUNDARY: Managed-parent initialization requires the captured Windows boundary.');
      }
    }
    this.managedRootIdentity = this.captureDirectoryIdentity(this.canonicalManagedRoot, 'managed root');
  }

  private captureDirectoryIdentity(candidate: string, label: string): DirectoryIdentity {
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      throw new Error(`INVALID_${label === 'managed root' ? 'MANAGED_ROOT' : 'REPOSITORY_ROOT'}: Unable to inspect ${label} "${candidate}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`INVALID_${label === 'managed root' ? 'MANAGED_ROOT' : 'REPOSITORY_ROOT'}: ${label} "${candidate}" must be a real directory.`);
    }

    let realPath: string;
    try {
      realPath = path.resolve(fs.realpathSync.native ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate));
    } catch (error) {
      throw new Error(`INVALID_${label === 'managed root' ? 'MANAGED_ROOT' : 'REPOSITORY_ROOT'}: Unable to resolve ${label} "${candidate}": ${error instanceof Error ? error.message : String(error)}`);
    }

    const lexical = path.resolve(candidate);
    if ((process.platform === 'win32' ? realPath.toLowerCase() !== lexical.toLowerCase() : realPath !== lexical)) {
      throw new Error(`INVALID_${label === 'managed root' ? 'MANAGED_ROOT' : 'REPOSITORY_ROOT'}: ${label} "${candidate}" resolves through an alias or junction.`);
    }
    return {
      realPath,
      dev: stat.dev,
      ino: stat.ino,
      birthtimeNs: stat.birthtimeNs,
    };
  }

  private assertRepositoryRootIdentity(): void {
    let current: DirectoryIdentity;
    try {
      current = this.captureDirectoryIdentity(this.canonicalRepoRoot, 'repository root');
    } catch {
      throw new PathIdentityError('PATH_IDENTITY_CHANGED', 'PATH_IDENTITY_CHANGED: Repository root can no longer be resolved safely.');
    }
    if (!sameDirectoryIdentity(this.repositoryRootIdentity, current)) {
      throw new PathIdentityError(
        'PATH_IDENTITY_CHANGED',
        `PATH_IDENTITY_CHANGED: Repository root identity changed from "${this.repositoryRootIdentity.realPath}".`,
      );
    }
  }

  private assertManagedRootIdentity(): void {
    let current: DirectoryIdentity;
    try {
      current = this.captureDirectoryIdentity(this.canonicalManagedRoot, 'managed root');
    } catch {
      throw new PathIdentityError('PATH_IDENTITY_CHANGED', 'PATH_IDENTITY_CHANGED: Managed root can no longer be resolved safely.');
    }
    if (!sameDirectoryIdentity(this.managedRootIdentity, current)) {
      throw new PathIdentityError(
        'PATH_IDENTITY_CHANGED',
        `PATH_IDENTITY_CHANGED: Managed root identity changed from "${this.managedRootIdentity.realPath}".`,
      );
    }
  }

  private assertRootIdentities(): void {
    this.assertRepositoryRootIdentity();
    this.assertManagedRootIdentity();
  }

  private captureTargetIdentity(targetPath: string, required: boolean): DirectoryIdentity | null {
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(targetPath, { bigint: true });
    } catch (error) {
      if (!required && isMissingFsError(error)) return null;
      if (isMissingFsError(error)) {
        throw new PathIdentityError('PATH_IDENTITY_CHANGED', `PATH_IDENTITY_CHANGED: Target "${targetPath}" disappeared.`);
      }
      throw new PathIdentityError(
        'PATH_CONTAINMENT_DENIED',
        `PATH_CONTAINMENT_DENIED: Unable to inspect target "${targetPath}" safely.`,
      );
    }

    if (stat.isSymbolicLink()) {
      throw new PathIdentityError(
        'PATH_CONTAINMENT_DENIED',
        `PATH_CONTAINMENT_DENIED: Target "${targetPath}" is a symbolic link or junction.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new PathIdentityError(
        'PATH_CONTAINMENT_DENIED',
        `PATH_CONTAINMENT_DENIED: Target "${targetPath}" is not a directory.`,
      );
    }

    let realPath: string;
    try {
      realPath = path.resolve(fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath));
    } catch {
      throw new PathIdentityError(
        'PATH_CONTAINMENT_DENIED',
        `PATH_CONTAINMENT_DENIED: Unable to resolve target "${targetPath}" safely.`,
      );
    }
    if (
      normalizePathForComparison(realPath) !== normalizePathForComparison(targetPath) ||
      !isPathWithinRoot(realPath, this.canonicalManagedRoot)
    ) {
      throw new PathIdentityError(
        'PATH_CONTAINMENT_DENIED',
        `PATH_CONTAINMENT_DENIED: Target "${targetPath}" does not resolve to the checked managed-root identity.`,
      );
    }

    return {
      realPath,
      dev: stat.dev,
      ino: stat.ino,
      birthtimeNs: stat.birthtimeNs,
    };
  }

  private assertTargetIdentity(
    targetPath: string,
    expected: DirectoryIdentity | null,
    requirePresent: boolean,
  ): DirectoryIdentity | null {
    const current = this.captureTargetIdentity(targetPath, requirePresent);
    if (!current) {
      if (!requirePresent && expected) return null;
      if (!expected) return null;
      throw new PathIdentityError(
        'PATH_IDENTITY_CHANGED',
        `PATH_IDENTITY_CHANGED: Target "${targetPath}" identity changed during the managed operation.`,
      );
    }
    if (!expected || !sameDirectoryIdentity(expected, current)) {
      throw new PathIdentityError(
        'PATH_IDENTITY_CHANGED',
        `PATH_IDENTITY_CHANGED: Target "${targetPath}" identity changed during the managed operation.`,
      );
    }
    return current;
  }

  private assertOperationBoundary(targetPath: string, expectedTarget: DirectoryIdentity | null, requireTarget: boolean): void {
    this.assertRootIdentities();
    this.assertTargetIdentity(targetPath, expectedTarget, requireTarget);
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private async withManagedRootLock<T>(onUnavailable: () => T, operation: () => Promise<T>): Promise<T> {
    if (process.platform !== 'win32') return onUnavailable();
    let boundary: WorktreeMutationBoundary | null = null;
    try {
      this.assertRootIdentities();
      boundary = await WorktreeMutationBoundary.acquire(this.canonicalManagedRoot);
      this.assertRootIdentities();
      const owner = { pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() };
      const deadline = Date.now() + GitWorktreeService.OPERATION_LOCK_TIMEOUT_MS;
      while (!await boundary.acquireOperationLock(owner)) {
        if (Date.now() >= deadline) return onUnavailable();
        await this.delay(GitWorktreeService.OPERATION_LOCK_RETRY_MS);
      }
      this.assertRootIdentities();
      return await operation();
    } catch { return onUnavailable(); }
    finally { await boundary?.close(); }
  }

  private async executeGitAtRepository(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.assertRootIdentities();
    const result = await this.executor.execute(this.gitExecutable, args, { cwd: this.canonicalRepoRoot, env: { GIT_OPTIONAL_LOCKS: '0' } });
    this.assertRootIdentities();
    return result;
  }

  private async executeGitWithTargetBoundary(
    args: string[],
    targetPath: string,
    targetIdentity: DirectoryIdentity,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.assertOperationBoundary(targetPath, targetIdentity, true);
    const result = await this.executor.execute(this.gitExecutable, args, {
      cwd: targetPath,
      env: { GIT_OPTIONAL_LOCKS: '0' },
    });
    this.assertRootIdentities();
    this.assertTargetIdentity(targetPath, targetIdentity, true);
    return result;
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
    const invalidEpoch = this.validateOwnershipEpoch(tuple);
    if (invalidEpoch) throw new Error(invalidEpoch.error);
    this.assertManagedRootIdentity();
    const canonicalJson = JSON.stringify({
      projectId: tuple.projectId,
      taskId: tuple.taskId,
      attemptId: tuple.attemptId ?? null,
      assignmentId: tuple.assignmentId,
      workerSlotId: tuple.workerSlotId,
      baseSha: tuple.baseSha.toLowerCase(),
      // Preserve the legacy unversioned namespace; it cannot address a
      // product worktree whose positive durable epoch is included here.
      ...(tuple.ownershipEpoch != null ? { ownershipEpoch: tuple.ownershipEpoch } : {}),
    });
    const digest = crypto.createHash('sha256').update(canonicalJson).digest('hex');
    const worktreeDirName = `afw-${digest.substring(0, 32)}`;
    const derivedPath = path.resolve(this.canonicalManagedRoot, worktreeDirName);

    if (!isPathWithinRoot(derivedPath, this.canonicalManagedRoot)) {
      throw new Error(`PATH_CONTAINMENT_DENIED: Derived path "${derivedPath}" is not within managed root.`);
    }

    return { worktreePath: derivedPath, digest };
  }

  private unsupportedMutationBoundary(): WorktreeFailure | null {
    return process.platform === 'win32' ? null : {
      status: 'FAILED', code: 'UNSUPPORTED_MUTATION_BOUNDARY',
      error: 'UNSUPPORTED_MUTATION_BOUNDARY: Managed worktree operations require the captured Windows boundary.',
    };
  }

  private validateOwnershipEpoch(tuple: WorktreeOwnershipTuple): WorktreeFailure | null {
    if (tuple.ownershipEpoch != null && (!Number.isSafeInteger(tuple.ownershipEpoch) || tuple.ownershipEpoch <= 0)) {
      return { status: 'FAILED', code: 'INVALID_OWNERSHIP_EPOCH',
        error: 'INVALID_OWNERSHIP_EPOCH: A supplied ownership epoch must be a positive safe integer.' };
    }
    return null;
  }

  /**
   * Asynchronously creates an isolated, detached, locked Git worktree for an assignment.
   */
  public async createWorktree(tuple: WorktreeOwnershipTuple): Promise<WorktreeCreateResult> {
    const invalidEpoch = this.validateOwnershipEpoch(tuple);
    if (invalidEpoch) return invalidEpoch;
    // Pure input policy remains available before a platform boundary, lock or
    // filesystem mutation. Commit existence is checked only inside the safe
    // supported boundary below.
    if (!tuple.baseSha || typeof tuple.baseSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(tuple.baseSha)) {
      return { status: 'FAILED', code: 'INVALID_SOURCE_SHA',
        error: 'INVALID_SOURCE_SHA: baseSha must be a 40-character hexadecimal string.' };
    }
    const unsupported = this.unsupportedMutationBoundary();
    if (unsupported) return unsupported;
    return this.withManagedRootLock<WorktreeCreateResult>(
      () => ({
        status: 'FAILED',
        code: 'PATH_CONTAINMENT_DENIED',
        error: 'PATH_CONTAINMENT_DENIED: Managed-root operation lock could not be acquired safely.',
      }),
      () => this.createWorktreeUnlocked(tuple),
    );
  }

  private async createWorktreeUnlocked(tuple: WorktreeOwnershipTuple): Promise<WorktreeCreateResult> {
    // 1. Validate Base SHA syntax
    if (!tuple.baseSha || typeof tuple.baseSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(tuple.baseSha)) {
      return {
        status: 'FAILED',
        code: 'INVALID_SOURCE_SHA',
        error: `INVALID_SOURCE_SHA: baseSha "${tuple.baseSha}" must be a 40-character hexadecimal string.`,
      };
    }
    const expectedSha = tuple.baseSha.toLowerCase();

    try {
      this.assertRootIdentities();
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Filesystem root identity could not be verified.',
      };
    }

    // 2. Prove exact source commit exists in repository
    let commitCheck: { exitCode: number; stdout: string; stderr: string };
    try {
      commitCheck = await this.executeGitAtRepository([
        'rev-parse', '--verify', '--quiet', `${expectedSha}^{commit}`,
      ]);
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Repository identity changed during source verification.',
      };
    }
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
    let targetIdentity: DirectoryIdentity | null = null;
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

    // 4. Verify the managed-root identity and prove that the target is absent.
    // lstat is intentional: a broken symlink must not be treated as absent.
    try {
      this.assertRootIdentities();
      targetIdentity = this.captureTargetIdentity(targetPath, false);
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Target identity could not be verified.',
        worktreePath: targetPath,
      };
    }
    if (targetIdentity) {
      return {
        status: 'FAILED',
        code: 'WORKTREE_ALREADY_EXISTS',
        error: `WORKTREE_ALREADY_EXISTS: Target directory "${targetPath}" already exists on filesystem.`,
        worktreePath: targetPath,
      };
    }

    // 5. Verify path is not already registered in git worktree list
    let porcelainList: PorcelainWorktreeEntry[];
    try {
      this.assertRootIdentities();
      porcelainList = await this.listPorcelain();
      this.assertRootIdentities();
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Worktree registration could not be verified safely.',
        worktreePath: targetPath,
      };
    }
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

    return this.createCapturedWorktree(tuple, targetPath, digest);
  }

  private capturedFailure(error: unknown): { code: WorktreeErrorCode; error: string } {
    const detail = error instanceof Error ? error.message : '';
    const code: WorktreeErrorCode = detail.includes('UNSUPPORTED_MUTATION_BOUNDARY') ? 'UNSUPPORTED_MUTATION_BOUNDARY'
      : detail.includes('WORKTREE_GIT_LAYOUT_UNSUPPORTED') ? 'UNSUPPORTED_GIT_LAYOUT'
      : detail.includes('WORKTREE_PARTIAL_SETUP_RETAINED') ? 'PARTIAL_WORKTREE_SETUP'
      : /WORKTREE_(TREE_ENTRY_UNSUPPORTED|CHECKOUT_NAME_UNSUPPORTED|CHECKOUT_ALIAS_COLLISION|CHECKOUT_LIMIT|BLOB_LIMIT|TREE_LIMIT)/.test(detail) ? 'UNSUPPORTED_CHECKOUT_ENTRY'
      : detail.includes('WORKTREE_DIRTY') ? 'DIRTY_WORKTREE'
      : detail.includes('WORKTREE_HEAD_CHANGED') ? 'HEAD_CHANGED'
      : /OWNER_RECEIPT|GIT_POINTER|GIT_ADMIN|NOT_ADMITTED/.test(detail) ? 'UNMANAGED_WORKTREE'
      : /BOUNDARY_|IDENTITY_CHANGED/.test(detail) ? 'PATH_IDENTITY_CHANGED' : 'GIT_ADD_FAILED';
    return { code, error: `${code}: Captured worktree mutation was denied; retain fenced state for recovery.` };
  }

  private async createCapturedWorktree(tuple: WorktreeOwnershipTuple, targetPath: string, digest: string): Promise<WorktreeCreateResult> {
    let mutation: ManagedGitWorktreeMutation | null = null;
    let failure: { code: WorktreeErrorCode; error: string } = { code: 'GIT_ADD_FAILED', error: 'GIT_ADD_FAILED: Captured checkout failed.' };
    try {
      mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: this.gitExecutable,
        repositoryRoot: this.canonicalRepoRoot, managedRoot: this.canonicalManagedRoot }, path.basename(targetPath));
      await mutation.create(tuple.baseSha.toLowerCase(), digest);
      const identity = this.captureTargetIdentity(targetPath, true)!;
      const head = await this.executeGitWithTargetBoundary(['rev-parse', 'HEAD'], targetPath, identity);
      const branch = await this.executeGitWithTargetBoundary(['branch', '--show-current'], targetPath, identity);
      const top = await this.executeGitWithTargetBoundary(['rev-parse', '--show-toplevel'], targetPath, identity);
      if (head.exitCode !== 0 || head.stdout.trim().toLowerCase() !== tuple.baseSha.toLowerCase() ||
          branch.exitCode !== 0 || branch.stdout.trim() !== '' || top.exitCode !== 0 ||
          normalizePathForComparison(top.stdout.trim()) !== normalizePathForComparison(targetPath)) {
        failure = { code: 'HEAD_BINDING_MISMATCH', error: 'HEAD_BINDING_MISMATCH: Captured checkout source/branch/root could not be verified.' };
      } else {
        const entries = await this.listPorcelain();
        const matching = entries.filter(entry => normalizePathForComparison(entry.worktreePath) === normalizePathForComparison(targetPath));
        if (matching.length !== 1 || !matching[0].isDetached || matching[0].headSha.toLowerCase() !== tuple.baseSha.toLowerCase()) {
          failure = { code: 'WORKTREE_REGISTRATION_MISMATCH', error: 'WORKTREE_REGISTRATION_MISMATCH: Captured checkout registration could not be verified.' };
        } else if (!matching[0].isLocked || matching[0].lockReason !== `AgentForge managed assignment ${digest.slice(0, 16)}`) {
          failure = { code: 'WORKTREE_LOCK_FAILED', error: 'WORKTREE_LOCK_FAILED: Captured worktree lock could not be verified.' };
        } else {
          const clean = await this.executeGitWithTargetBoundary(['status', '--porcelain', '-uall'], targetPath, identity);
          if (clean.exitCode === 0 && clean.stdout.trim() === '') {
            this.assertOperationBoundary(targetPath, identity, true);
            await mutation.close(); mutation = null;
            return { status: 'CREATED', worktreePath: targetPath, baseSha: tuple.baseSha.toLowerCase(), ownershipDigest: digest };
          }
          failure = { code: 'HEAD_BINDING_MISMATCH', error: 'HEAD_BINDING_MISMATCH: Exact checkout content did not pass independent clean-state verification.' };
        }
      }
    } catch (error) { failure = this.capturedFailure(error); }
    try { await mutation?.rollbackCreated(); }
    catch { failure = { code: 'CREATE_ROLLBACK_FAILED', error: 'CREATE_ROLLBACK_FAILED: Captured setup could not be rolled back; retain owned filesystem and administrative evidence.' }; }
    finally { await mutation?.close(); }
    return { status: 'FAILED', ...failure, worktreePath: targetPath };
  }

  /**
   * Inspects a managed worktree without mutating any filesystem or Git state.
   */
  public async inspectWorktree(tuple: WorktreeOwnershipTuple): Promise<WorktreeInspectResult> {
    const invalidEpoch = this.validateOwnershipEpoch(tuple);
    if (invalidEpoch) return invalidEpoch;
    const unsupported = this.unsupportedMutationBoundary();
    if (unsupported) return unsupported;
    return this.withManagedRootLock<WorktreeInspectResult>(
      () => ({
        status: 'FAILED',
        code: 'PATH_CONTAINMENT_DENIED',
        error: 'PATH_CONTAINMENT_DENIED: Managed-root operation lock could not be acquired safely.',
      }),
      () => this.inspectWorktreeUnlocked(tuple),
    );
  }

  private async inspectWorktreeUnlocked(tuple: WorktreeOwnershipTuple): Promise<WorktreeInspectResult> {
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

    let targetIdentity: DirectoryIdentity | null;
    try {
      this.assertRootIdentities();
      targetIdentity = this.captureTargetIdentity(targetPath, false);
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Target identity could not be inspected safely.',
        worktreePath: targetPath,
      };
    }

    const exists = targetIdentity !== null;
    let porcelainList: PorcelainWorktreeEntry[];
    try {
      this.assertRootIdentities();
      porcelainList = await this.listPorcelain();
      this.assertRootIdentities();
      if (targetIdentity) this.assertTargetIdentity(targetPath, targetIdentity, true);
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'INSPECTION_FAILED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'INSPECTION_FAILED: Worktree identity changed during inspection.',
        worktreePath: targetPath,
      };
    }
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
      let inspectionBoundary: ManagedGitWorktreeMutation | null = null;
      try {
        if (process.platform === 'win32') {
          inspectionBoundary = await ManagedGitWorktreeMutation.prepare({ gitExecutable: this.gitExecutable,
            repositoryRoot: this.canonicalRepoRoot, managedRoot: this.canonicalManagedRoot }, path.basename(targetPath), false);
          await inspectionBoundary.captureOwned(expectedSha, digest, true);
          this.assertTargetIdentity(targetPath, targetIdentity, true);
        }
        const headCheck = await this.executeGitWithTargetBoundary(['rev-parse', 'HEAD'], targetPath, targetIdentity!);
        if (headCheck.exitCode === 0) {
          headSha = headCheck.stdout.trim().toLowerCase();
        }
        const branchCheck = await this.executeGitWithTargetBoundary(
          ['branch', '--show-current'],
          targetPath,
          targetIdentity!,
        );
        if (branchCheck.exitCode === 0) {
          detached = branchCheck.stdout.trim() === '';
        }
        const statusCheck = await this.executeGitWithTargetBoundary(
          ['status', '--porcelain', '-uall'],
          targetPath,
          targetIdentity!,
        );
        if (statusCheck.exitCode === 0) {
          clean = statusCheck.stdout.trim() === '' && (!inspectionBoundary || await inspectionBoundary.isExactCheckout());
        }
      } catch (error) {
        if (error instanceof PathIdentityError) {
          return {
            status: 'FAILED',
            code: error.code,
            error: error.message,
            worktreePath: targetPath,
          };
        }
        if (process.platform === 'win32') return { status: 'FAILED', ...this.capturedFailure(error), worktreePath: targetPath };
        clean = false;
      } finally { await inspectionBoundary?.close(); }
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
    const invalidEpoch = this.validateOwnershipEpoch(tuple);
    if (invalidEpoch) return invalidEpoch;
    const unsupported = this.unsupportedMutationBoundary();
    if (unsupported) return unsupported;
    return this.withManagedRootLock<WorktreeRemoveResult>(
      () => ({
        status: 'FAILED',
        code: 'PATH_CONTAINMENT_DENIED',
        error: 'PATH_CONTAINMENT_DENIED: Managed-root operation lock could not be acquired safely.',
      }),
      () => this.removeWorktreeUnlocked(tuple),
    );
  }

  private async removeWorktreeUnlocked(tuple: WorktreeOwnershipTuple): Promise<WorktreeRemoveResult> {
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

    // Check directory existence and retain its filesystem identity for every
    // subsequent Git operation. A path string alone is not an owner fence.
    let targetIdentity: DirectoryIdentity | null;
    try {
      this.assertRootIdentities();
      targetIdentity = this.captureTargetIdentity(targetPath, false);
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Target identity could not be verified safely.',
        worktreePath: targetPath,
      };
    }
    if (!targetIdentity) {
      return {
        status: 'FAILED',
        code: 'UNMANAGED_WORKTREE',
        error: `UNMANAGED_WORKTREE: Target worktree directory "${targetPath}" does not exist on filesystem.`,
        worktreePath: targetPath,
      };
    }

    // Check registration in porcelain list
    let porcelainList: PorcelainWorktreeEntry[];
    try {
      this.assertOperationBoundary(targetPath, targetIdentity, true);
      porcelainList = await this.listPorcelain();
      this.assertOperationBoundary(targetPath, targetIdentity, true);
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Worktree registration could not be verified safely.',
        worktreePath: targetPath,
      };
    }
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

    const expectedLockReason = `AgentForge managed assignment ${digest.substring(0, 16)}`;
    if (entry.isLocked && entry.lockReason !== expectedLockReason) {
      return {
        status: 'FAILED',
        code: 'UNMANAGED_WORKTREE',
        error: `UNMANAGED_WORKTREE: Worktree "${targetPath}" is locked by a different ownership identity. Removal denied.`,
        worktreePath: targetPath,
      };
    }

    // Check HEAD matches expected baseSha
    let headCheck: { exitCode: number; stdout: string; stderr: string };
    try {
      headCheck = await this.executeGitWithTargetBoundary(['rev-parse', 'HEAD'], targetPath, targetIdentity);
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'HEAD_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Worktree identity changed before HEAD verification.',
        worktreePath: targetPath,
      };
    }
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
    let statusCheck: { exitCode: number; stdout: string; stderr: string };
    try {
      statusCheck = await this.executeGitWithTargetBoundary(
        ['status', '--porcelain', '-uall'],
        targetPath,
        targetIdentity,
      );
    } catch (error) {
      const code = error instanceof PathIdentityError ? error.code : 'PATH_IDENTITY_CHANGED';
      return {
        status: 'FAILED',
        code,
        error: error instanceof Error ? error.message : 'PATH_IDENTITY_CHANGED: Worktree identity changed before clean-state verification.',
        worktreePath: targetPath,
      };
    }
    if (statusCheck.exitCode !== 0 || statusCheck.stdout.trim() !== '') {
      return {
        status: 'FAILED',
        code: 'DIRTY_WORKTREE',
        error: `DIRTY_WORKTREE: Worktree "${targetPath}" has uncommitted or untracked changes. Removal denied.`,
        worktreePath: targetPath,
      };
    }

    let mutation: ManagedGitWorktreeMutation | null = null;
    try {
      mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: this.gitExecutable,
        repositoryRoot: this.canonicalRepoRoot, managedRoot: this.canonicalManagedRoot }, path.basename(targetPath), false);
      await mutation.captureOwned(expectedSha, digest);
      this.assertOperationBoundary(targetPath, targetIdentity, true);
      await mutation.removeOwned();
      const remaining = await this.listPorcelain();
      if (this.captureTargetIdentity(targetPath, false) || remaining.some(item => normalizePathForComparison(item.worktreePath) === normalizePathForComparison(targetPath))) {
        return { status: 'FAILED', code: 'REMOVE_FAILED', error: 'REMOVE_FAILED: Captured worktree remains present or registered.', worktreePath: targetPath };
      }
      return { status: 'REMOVED', worktreePath: targetPath, ownershipDigest: digest };
    } catch (error) { return { status: 'FAILED', ...this.capturedFailure(error), worktreePath: targetPath }; }
    finally { await mutation?.close(); }
  }

  /** Parses read-only Git worktree registration observations. */
  public async listPorcelain(): Promise<PorcelainWorktreeEntry[]> {
    const res = await this.executeGitAtRepository(['worktree', 'list', '--porcelain']);
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
