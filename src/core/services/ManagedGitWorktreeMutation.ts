import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { WorktreeMutationBoundary, type NativeIdentity } from './WorktreeMutationBoundary';

const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_CHECKOUT_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 32_768;

export interface CheckoutEntry { name: string; mode: number; oid: string }
export interface ManagedWorktreeMutationConfig {
  gitExecutable: string;
  repositoryRoot: string;
  managedRoot: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_|NAMESPACE)/.test(key)) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  return env;
}

/** Binary framing is retained; Git stdout is never converted through UTF-8. */
class BinaryGitReader {
  private buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private notify: (() => void) | null = null;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly deadline: NodeJS.Timeout;
  private exited = false;
  constructor(executable: string, args: string[], cwd: string, private readonly limit: number) {
    this.child = spawn(executable, args, { cwd, env: gitEnvironment(), shell: false, windowsHide: true, stdio: 'pipe' });
    this.deadline = setTimeout(() => this.fail('WORKTREE_GIT_READ_TIMEOUT'), 120_000);
    this.child.stderr.resume();
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.buffer.length + chunk.length > limit) return this.fail('WORKTREE_GIT_READ_LIMIT');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.notify?.();
    });
    this.child.on('error', () => this.fail('WORKTREE_GIT_READ_FAILED'));
    this.child.stdin.on('error', () => this.fail('WORKTREE_GIT_READ_FAILED'));
    this.child.on('close', code => {
      this.exited = true;
      if (code !== 0) this.fail('WORKTREE_GIT_READ_FAILED');
      this.notify?.();
    });
  }
  private fail(code: string): void {
    this.failure ??= new Error(code);
    if (!this.exited) this.child.kill();
    this.notify?.();
  }
  private async changed(): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>(resolve => { this.notify = resolve; });
    this.notify = null;
    if (this.failure) throw this.failure;
  }
  async all(): Promise<Buffer> {
    this.child.stdin.end();
    while (!this.exited) await this.changed();
    if (this.failure) throw this.failure;
    return this.buffer;
  }
  async blob(oid: string): Promise<Buffer> {
    this.child.stdin.write(oid + '\n');
    let end: number;
    while ((end = this.buffer.indexOf(10)) < 0) {
      if (this.buffer.length > 128 || this.exited) throw new Error('WORKTREE_BLOB_HEADER_INVALID');
      await this.changed();
    }
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(this.buffer.subarray(0, end).toString('ascii'));
    if (!match || match[1] !== oid) throw new Error('WORKTREE_BLOB_HEADER_INVALID');
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) throw new Error('WORKTREE_BLOB_LIMIT');
    this.buffer = this.buffer.subarray(end + 1);
    while (this.buffer.length < size + 1) {
      if (this.exited) throw new Error('WORKTREE_BLOB_TRUNCATED');
      await this.changed();
    }
    if (this.buffer[size] !== 10) throw new Error('WORKTREE_BLOB_FRAME_INVALID');
    const contents = Buffer.from(this.buffer.subarray(0, size));
    this.buffer = this.buffer.subarray(size + 1);
    if (crypto.createHash('sha1').update(`blob ${size}\0`).update(contents).digest('hex') !== oid) {
      throw new Error('WORKTREE_BLOB_HASH_MISMATCH');
    }
    return contents;
  }
  async close(): Promise<void> {
    clearTimeout(this.deadline);
    if (this.exited) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.child.kill(), 2000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }
}

function safeName(name: string): void {
  if (!name || Buffer.byteLength(name) > 30_000 || name.split('/').some(segment =>
    !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git' ||
    /[\\:\x00-\x1f\x7f*?"<>|]/.test(segment) || /[. ]$/.test(segment) || segment.length > 255 ||
    /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment))) {
    throw new Error('WORKTREE_CHECKOUT_NAME_UNSUPPORTED');
  }
}

export function parseCheckoutTree(tree: Buffer): CheckoutEntry[] {
  if (tree.length > MAX_TREE_BYTES || (tree.length > 0 && tree[tree.length - 1] !== 0)) throw new Error('WORKTREE_TREE_INVALID');
  const entries: CheckoutEntry[] = [];
  const aliases = new Set<string>();
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match || Buffer.from(record).toString('utf8') !== record || record.includes('\ufffd')) throw new Error('WORKTREE_TREE_ENTRY_UNSUPPORTED');
    const name = match[3]; safeName(name);
    const alias = name.toLowerCase();
    if (aliases.has(alias)) throw new Error('WORKTREE_CHECKOUT_ALIAS_COLLISION');
    aliases.add(alias);
    entries.push({ name, mode: parseInt(match[1], 8), oid: match[2] });
    if (entries.length > MAX_ENTRIES) throw new Error('WORKTREE_TREE_LIMIT');
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  // A file and directory sharing an alias cannot both be materialized on the
  // supported Windows boundary. Detect that before reserving either root.
  for (const entry of entries) {
    const segments = entry.name.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/').toLowerCase();
      if (aliases.has(dir)) throw new Error('WORKTREE_CHECKOUT_ALIAS_COLLISION');
    }
  }
  return entries;
}

/** Git index v2, complete immutable tree, zero stat cache, SHA-1 checksum. */
export function encodeCheckoutIndex(entries: CheckoutEntry[]): Buffer {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const records = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))).map(entry => {
    safeName(entry.name);
    if (!/^[a-f0-9]{40}$/.test(entry.oid) || ![0o100644, 0o100755].includes(entry.mode)) throw new Error('WORKTREE_INDEX_ENTRY_INVALID');
    const name = Buffer.from(entry.name);
    const record = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    record.writeUInt32BE(entry.mode, 24);
    Buffer.from(entry.oid, 'hex').copy(record, 40);
    record.writeUInt16BE(Math.min(name.length, 0xfff), 60);
    name.copy(record, 62);
    return record;
  });
  const index = Buffer.concat([header, ...records]);
  return Buffer.concat([index, crypto.createHash('sha1').update(index).digest()]);
}

/** Captured checkout/metadata engine used by GitWorktreeService. */
export class ManagedGitWorktreeMutation {
  private checkout: WorktreeMutationBoundary | null = null;
  private metadata: WorktreeMutationBoundary | null = null;
  private administrationAnchor: WorktreeMutationBoundary | null = null;
  private adminRoot: string | null = null;
  private checkoutReserved = false;
  private metadataReserved = false;
  private ownedExisting = false;
  private ownedSha: string | null = null;
  private capturedSha: string | null = null;
  private constructor(private readonly config: ManagedWorktreeMutationConfig, public readonly childName: string) {}

  static async prepare(config: ManagedWorktreeMutationConfig, childName: string, initialize = true): Promise<ManagedGitWorktreeMutation> {
    if (process.platform !== 'win32') throw new Error('UNSUPPORTED_MUTATION_BOUNDARY');
    if (!/^afw-[a-f0-9]{32}$/.test(childName)) throw new Error('WORKTREE_MUTATION_NAME_DENIED');
    const mutation = new ManagedGitWorktreeMutation(config, childName);
    const sourceIdentity = fs.lstatSync(config.repositoryRoot, { bigint: true });
    try {
      // Only primary administration has a source-root authority here. A .git
      // pointer or redirected commondir must not select another repository for
      // mutation. Unsupported layouts remain read-only and explicitly fenced.
      const primaryAdmin = path.join(config.repositoryRoot, '.git');
      let expectedAdmin: fs.BigIntStats;
      try { expectedAdmin = fs.lstatSync(primaryAdmin, { bigint: true }); }
      catch { throw new Error('WORKTREE_GIT_LAYOUT_UNSUPPORTED'); }
      if (!sourceIdentity.isDirectory() || sourceIdentity.isSymbolicLink() ||
          !expectedAdmin.isDirectory() || expectedAdmin.isSymbolicLink()) throw new Error('WORKTREE_GIT_LAYOUT_UNSUPPORTED');
      mutation.checkout = await WorktreeMutationBoundary.acquire(config.managedRoot, initialize);
      mutation.administrationAnchor = await WorktreeMutationBoundary.acquire(primaryAdmin);
      const checkedAdmin = fs.lstatSync(primaryAdmin, { bigint: true });
      if (expectedAdmin.dev !== checkedAdmin.dev || expectedAdmin.ino !== checkedAdmin.ino ||
          expectedAdmin.birthtimeNs !== checkedAdmin.birthtimeNs) throw new Error('WORKTREE_SOURCE_IDENTITY_CHANGED');
      // Match Git's read-only observation against the independently captured
      // primary admin root before initializing any administrative parent.
      const gitdir = await mutation.read(['rev-parse', '--path-format=absolute', '--git-common-dir'], 32_768);
      const commonRoot = gitdir.toString('utf8').trim();
      if (!path.isAbsolute(commonRoot) || /[\0\r\n]/.test(commonRoot) ||
          fs.realpathSync.native(commonRoot).toLowerCase() !== mutation.administrationAnchor.managedRoot.toLowerCase()) {
        throw new Error('WORKTREE_GIT_LAYOUT_UNSUPPORTED');
      }
      const sourceNow = fs.lstatSync(config.repositoryRoot, { bigint: true });
      const adminNow = fs.lstatSync(primaryAdmin, { bigint: true });
      if (!sourceNow.isDirectory() || sourceNow.isSymbolicLink() || sourceIdentity.ino !== sourceNow.ino ||
          sourceIdentity.dev !== sourceNow.dev || sourceIdentity.birthtimeNs !== sourceNow.birthtimeNs) throw new Error('WORKTREE_SOURCE_IDENTITY_CHANGED');
      if (!adminNow.isDirectory() || adminNow.isSymbolicLink() || expectedAdmin.dev !== adminNow.dev ||
          expectedAdmin.ino !== adminNow.ino || expectedAdmin.birthtimeNs !== adminNow.birthtimeNs) throw new Error('WORKTREE_SOURCE_IDENTITY_CHANGED');
      mutation.adminRoot = path.join(mutation.administrationAnchor.managedRoot, 'worktrees');
      mutation.metadata = await WorktreeMutationBoundary.acquire(mutation.adminRoot, initialize);
      return mutation;
    } catch (error) { await mutation.close(); throw error; }
  }

  private async read(args: string[], limit: number, cwd = this.config.repositoryRoot): Promise<Buffer> {
    const reader = new BinaryGitReader(this.config.gitExecutable, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], cwd, limit);
    try { return await reader.all(); } finally { await reader.close(); }
  }

  async create(baseSha: string, ownershipDigest: string): Promise<string> {
    if (!/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{64}$/.test(ownershipDigest) ||
        this.childName !== `afw-${ownershipDigest.slice(0, 32)}` || !this.checkout || !this.metadata || !this.adminRoot) {
      throw new Error('WORKTREE_MUTATION_OWNER_DENIED');
    }
    const resolved = (await this.read(['rev-parse', '--verify', `${baseSha}^{commit}`], 128)).toString('ascii').trim();
    if (resolved !== baseSha) throw new Error('WORKTREE_SOURCE_COMMIT_MISMATCH');
    const entries = parseCheckoutTree(await this.read(['ls-tree', '--full-tree', '-r', '-z', baseSha], MAX_TREE_BYTES));
    const target = await this.checkout.reserveChild(this.childName); this.checkoutReserved = true;
    await this.metadata.reserveChild(this.childName); this.metadataReserved = true;
    const admin = path.join(this.adminRoot, this.childName);
    // A durable owner receipt fences interrupted setup. The service must
    // verify native identities and this receipt before any resumed cleanup.
    const targetIdentity = this.checkout.capturedIdentity(this.childName);
    await this.metadata.writeNewFile(this.childName, 'agent-forge-owner.json', Buffer.from(JSON.stringify({
      version: 1, ownershipDigest, baseSha, targetIdentity,
      adminIdentity: this.metadata.capturedIdentity(this.childName), phase: 'CREATING',
    }) + '\n'));
    await this.metadata.writeNewFile(this.childName, 'HEAD', Buffer.from(baseSha + '\n'));
    await this.metadata.writeNewFile(this.childName, 'commondir', Buffer.from('../..\n'));
    // Git's worktree discovery removes the final component using '/'. Use
    // Git's portable metadata spelling even on Windows, not path.join's '\\'.
    await this.metadata.writeNewFile(this.childName, 'gitdir', Buffer.from(path.join(target, '.git').replace(/\\/g, '/') + '\n'));
    await this.metadata.writeNewFile(this.childName, 'locked', Buffer.from(`AgentForge managed assignment ${ownershipDigest.slice(0, 16)}\n`));
    const directories = new Set<string>();
    const blobs = new BinaryGitReader(this.config.gitExecutable, ['cat-file', '--batch'], this.config.repositoryRoot, MAX_BLOB_BYTES + 129);
    let total = 0;
    try {
      for (const entry of entries) {
        const segments = entry.name.split('/');
        for (let i = 1; i < segments.length; i++) {
          const dir = segments.slice(0, i).join('/');
          if (!directories.has(dir.toLowerCase())) { await this.checkout.createDirectory(this.childName, dir); directories.add(dir.toLowerCase()); }
        }
        const contents = await blobs.blob(entry.oid);
        total += contents.length;
        if (total > MAX_CHECKOUT_BYTES) throw new Error('WORKTREE_CHECKOUT_LIMIT');
        await this.checkout.writeNewFile(this.childName, entry.name, contents);
      }
    } finally { await blobs.close(); }
    await this.metadata.writeNewFile(this.childName, 'index', encodeCheckoutIndex(entries));
    await this.checkout.writeNewFile(this.childName, '.git', Buffer.from(`gitdir: ${admin.replace(/\\/g, '/')}\n`));
    // A separate immutable, flushed receipt closes materialization. An
    // interrupted checkout is never inferred complete from HEAD or Git status.
    await this.metadata.writeNewFile(this.childName, 'agent-forge-complete.json', Buffer.from(JSON.stringify({
      version: 1, ownershipDigest, baseSha, targetIdentity,
      adminIdentity: this.metadata.capturedIdentity(this.childName), phase: 'MATERIALIZED',
    }) + '\n'));
    return target;
  }

  async captureOwned(baseSha: string, ownershipDigest: string, inspectionOnly = false): Promise<string> {
    this.ownedExisting = false; this.ownedSha = null; this.capturedSha = null;
    if (!/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{64}$/.test(ownershipDigest) ||
        this.childName !== `afw-${ownershipDigest.slice(0, 32)}` || !this.checkout || !this.metadata || !this.adminRoot) {
      throw new Error('WORKTREE_MUTATION_OWNER_DENIED');
    }
    const target = await this.checkout.captureChild(this.childName);
    await this.metadata.captureChild(this.childName);
    await this.checkout.sealTree(this.childName);
    await this.metadata.sealTree(this.childName);
    const receipt = JSON.parse((await this.metadata.readCapturedFile(this.childName, 'agent-forge-owner.json')).toString('utf8')) as {
      version: number; ownershipDigest: string; baseSha: string; targetIdentity: NativeIdentity; adminIdentity: NativeIdentity; phase: string;
    };
    const same = (a: NativeIdentity | undefined, b: NativeIdentity) => !!a && a.volume === b.volume && a.fileId === b.fileId && a.created === b.created;
    if (receipt.version !== 1 || receipt.phase !== 'CREATING' || receipt.ownershipDigest !== ownershipDigest || receipt.baseSha !== baseSha ||
        !same(receipt.targetIdentity, this.checkout.capturedIdentity(this.childName)) ||
        !same(receipt.adminIdentity, this.metadata.capturedIdentity(this.childName))) throw new Error('WORKTREE_OWNER_RECEIPT_MISMATCH');
    let completion: typeof receipt;
    try { completion = JSON.parse((await this.metadata.readCapturedFile(this.childName, 'agent-forge-complete.json')).toString('utf8')); }
    catch { throw new Error('WORKTREE_PARTIAL_SETUP_RETAINED'); }
    if (!completion || completion.phase !== 'MATERIALIZED') throw new Error('WORKTREE_PARTIAL_SETUP_RETAINED');
    if (completion.version !== 1 || completion.ownershipDigest !== ownershipDigest || completion.baseSha !== baseSha ||
        !same(completion.targetIdentity, this.checkout.capturedIdentity(this.childName)) ||
        !same(completion.adminIdentity, this.metadata.capturedIdentity(this.childName))) throw new Error('WORKTREE_OWNER_RECEIPT_MISMATCH');
    const pointer = (await this.checkout.readCapturedFile(this.childName, '.git')).toString('utf8').trim();
    if (pointer !== `gitdir: ${path.join(this.adminRoot, this.childName).replace(/\\/g, '/')}`) throw new Error('WORKTREE_GIT_POINTER_MISMATCH');
    const readAdmin = async (file: string) => (await this.metadata!.readCapturedFile(this.childName, file)).toString('utf8').trim();
    if (await readAdmin('commondir') !== '../..' || await readAdmin('gitdir') !== path.join(target, '.git').replace(/\\/g, '/')) throw new Error('WORKTREE_GIT_ADMIN_MISMATCH');
    if (!inspectionOnly) {
      if (await readAdmin('HEAD') !== baseSha || await readAdmin('locked') !== `AgentForge managed assignment ${ownershipDigest.slice(0, 16)}`) throw new Error('WORKTREE_GIT_ADMIN_MISMATCH');
      this.ownedExisting = true;
      this.ownedSha = baseSha;
    }
    this.capturedSha = baseSha;
    return target;
  }

  /** Git's mutable index can hide dirty files; compare the captured bytes too. */
  async isExactCheckout(): Promise<boolean> {
    if (!this.capturedSha || !this.checkout) throw new Error('WORKTREE_CLEAN_CHECK_NOT_ADMITTED');
    const entries = parseCheckoutTree(await this.read(['ls-tree', '--full-tree', '-r', '-z', this.capturedSha], MAX_TREE_BYTES));
    const directories = new Set<string>();
    for (const entry of entries) {
      const parts = entry.name.split('/');
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    }
    const shape = [...entries.map(entry => `F:${entry.name}`), 'F:.git', ...Array.from(directories, name => `D:${name}`)].sort();
    const expectedShape = crypto.createHash('sha256').update(shape.join('\0') + '\0').digest('hex');
    if (await this.checkout.capturedTreeShape(this.childName) !== expectedShape) return false;
    const reader = new BinaryGitReader(this.config.gitExecutable, ['cat-file', '--batch'], this.config.repositoryRoot, MAX_BLOB_BYTES + 129);
    let total = 0;
    try {
      for (const entry of entries) {
        const contents = await reader.blob(entry.oid);
        total += contents.length;
        if (total > MAX_CHECKOUT_BYTES) throw new Error('WORKTREE_CHECKOUT_LIMIT');
        const expected = crypto.createHash('sha256').update(contents).digest('hex');
        if (await this.checkout.hashCapturedFile(this.childName, entry.name) !== expected) return false;
      }
      return true;
    } finally { await reader.close(); }
  }

  /** Captured owner plus fresh independent Git state is required for cleanup. */
  async removeOwned(): Promise<void> {
    if (!this.ownedExisting || !this.ownedSha || !this.checkout || !this.metadata) throw new Error('WORKTREE_CLEANUP_NOT_ADMITTED');
    const target = path.join(this.config.managedRoot, this.childName);
    const head = (await this.read(['rev-parse', 'HEAD'], 128, target)).toString('ascii').trim();
    const branch = (await this.read(['branch', '--show-current'], 8192, target)).toString('utf8').trim();
    if (head !== this.ownedSha || branch !== '') throw new Error('WORKTREE_HEAD_CHANGED');
    const status = await this.read(['status', '--porcelain', '-z', '-uall'], MAX_TREE_BYTES, target);
    if (status.length !== 0 || !await this.isExactCheckout()) throw new Error('WORKTREE_DIRTY');
    await this.checkout.deleteCapturedTree(this.childName);
    await this.metadata.deleteCapturedTree(this.childName);
    this.ownedExisting = false;
    this.ownedSha = null;
  }

  /** Only objects reserved by this engine instance may be rolled back here. */
  async rollbackCreated(): Promise<void> {
    if (this.checkoutReserved && this.checkout) {
      await this.checkout.sealTree(this.childName);
      await this.checkout.deleteCapturedTree(this.childName);
      this.checkoutReserved = false;
    }
    if (this.metadataReserved && this.metadata) {
      await this.metadata.sealTree(this.childName);
      await this.metadata.deleteCapturedTree(this.childName);
      this.metadataReserved = false;
    }
  }

  async close(): Promise<void> {
    await this.metadata?.close(); this.metadata = null;
    await this.administrationAnchor?.close(); this.administrationAnchor = null;
    await this.checkout?.close(); this.checkout = null;
  }
}
