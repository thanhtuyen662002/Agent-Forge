import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WINDOWS_DIRECTORY_BOOTSTRAP, WINDOWS_DIRECTORY_BOUNDARY } from './worktreeBoundaryScripts';

export interface NativeIdentity { volume: string; fileId: string; created: string }
interface Response { ok: boolean; identity?: NativeIdentity; error?: string; data?: string; root?: string }

/** Windows kernel primitives, awaiting complete Git/ownership integration. */
export class WorktreeMutationBoundary {
  private buffer = '';
  private closed = false;
  private volume: string | null = null;
  private readonly captured = new Map<string, NativeIdentity>();
  private pending: { resolve: (value: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private root: string) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      this.buffer += data;
      if (this.buffer.length > 16_384) return this.abort('BOUNDARY_PROTOCOL_OVERFLOW');
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        if (!this.pending) return this.abort('BOUNDARY_UNEXPECTED_RESPONSE');
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        try {
          const result = JSON.parse(line) as Response;
          if (typeof result.ok !== 'boolean') throw new Error('BOUNDARY_INVALID_RESPONSE');
          pending.resolve(result);
        } catch { pending.reject(new Error('BOUNDARY_INVALID_RESPONSE')); this.abort('BOUNDARY_INVALID_RESPONSE'); }
      }
    });
    // Upstream compiler/PowerShell diagnostics can contain host paths. Errors
    // returned to the caller are fixed codes; raw diagnostics are not persisted.
    child.stderr.resume();
    child.on('error', () => this.abort('BOUNDARY_HELPER_FAILED'));
    child.on('exit', () => this.abort('BOUNDARY_HELPER_EXITED'));
    child.stdin.on('error', () => this.abort('BOUNDARY_HELPER_FAILED'));
  }

  public get managedRoot(): string { return this.root; }

  private static parameters(managedRoot: string, initialize: boolean) {
    const root = path.resolve(managedRoot);
    if (!/^[a-z]:\\/i.test(root) || root.startsWith('\\\\') || root.length > 2048) throw new Error('UNSUPPORTED_MUTATION_BOUNDARY');
    let anchor = root;
    while (initialize && !fs.existsSync(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
    const expected = fs.lstatSync(anchor, { bigint: true });
    if (!expected.isDirectory() || expected.isSymbolicLink() || expected.ino === 0n) throw new Error('BOUNDARY_ROOT_ALIAS_DENIED');
    // The native helper walks every raw segment relative to captured parents,
    // allowing a genuine 8.3 spelling without ever following a reparse. Before
    // creating a missing segment it must match this checked existing anchor.
    return { payload: { root, initialize: initialize ? '1' : '0', anchor, anchorId: expected.ino.toString(),
      anchorCreated: (expected.birthtimeNs / 100n + 116444736000000000n).toString() }, expected, anchor };
  }

  public static initializeSync(managedRoot: string): NativeIdentity & { root: string } {
    if (process.platform !== 'win32') throw new Error('UNSUPPORTED_MUTATION_BOUNDARY');
    const { payload } = this.parameters(managedRoot, true);
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_DIRECTORY_BOOTSTRAP, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15_000,
      maxBuffer: 65_536, input: JSON.stringify(WINDOWS_DIRECTORY_BOUNDARY) + '\n' + JSON.stringify(payload) + '\n' + JSON.stringify({ op: 'close' }) + '\n' });
    if (result.status !== 0 || result.error) throw new Error('BOUNDARY_INITIALIZATION_DENIED');
    let response: Response;
    try { response = JSON.parse(result.stdout.trim()) as Response; } catch { throw new Error('BOUNDARY_INITIALIZATION_DENIED'); }
    const identity = response.identity;
    const root = response.root;
    if (!root || !path.isAbsolute(root)) throw new Error('BOUNDARY_INITIALIZATION_DENIED');
    const stat = fs.lstatSync(root, { bigint: true });
    if (!response.ok || !identity || !stat.isDirectory() || stat.isSymbolicLink() ||
        fs.realpathSync.native(root).toLowerCase() !== root.toLowerCase() || identity.fileId !== stat.ino.toString() ||
        !/^[1-9]\d*$/.test(identity.volume) || identity.created !== (stat.birthtimeNs / 100n + 116444736000000000n).toString()) throw new Error('BOUNDARY_INITIALIZATION_DENIED');
    return { ...identity, root };
  }

  public static async acquire(managedRoot: string, initialize = false): Promise<WorktreeMutationBoundary> {
    if (process.platform !== 'win32') throw new Error('UNSUPPORTED_MUTATION_BOUNDARY');
    const { payload, expected, anchor } = this.parameters(managedRoot, initialize);
    const root = payload.root;
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_DIRECTORY_BOOTSTRAP, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
    const boundary = new WorktreeMutationBoundary(child, root);
    try {
      // A short trusted bootstrap avoids the Windows command-line size limit.
      // The only executable source is this repository constant; later records
      // are parsed as data by that source, never interpreted as shell text.
      child.stdin.write(JSON.stringify(WINDOWS_DIRECTORY_BOUNDARY) + '\n');
      const response = await boundary.request(payload);
      if (!response.root || !path.isAbsolute(response.root)) throw new Error('BOUNDARY_ROOT_IDENTITY_CHANGED');
      boundary.root = response.root;
      boundary.verify(response.identity, boundary.root);
      boundary.volume = response.identity!.volume;
      const actual = fs.lstatSync(anchor, { bigint: true });
      if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.birthtimeNs !== actual.birthtimeNs) throw new Error('BOUNDARY_ROOT_IDENTITY_CHANGED');
      return boundary;
    } catch (error) { await boundary.close(); throw error; }
  }

  private verify(identity: NativeIdentity | undefined, candidate: string): void {
    if (!identity || typeof identity.fileId !== 'string' || typeof identity.volume !== 'string') throw new Error('BOUNDARY_IDENTITY_MISSING');
    const actual = fs.lstatSync(candidate, { bigint: true });
    // Windows Node reports st_dev=0 on some supported volumes. Retain the
    // nonzero native volume serial and compare every child with that anchor;
    // independently match the exact BigInt file ID, never a rounded number.
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.ino === 0n ||
        !/^\d+$/.test(identity.volume) || identity.volume === '0' || !/^\d+$/.test(identity.created) || identity.created === '0' ||
        (this.volume !== null && identity.volume !== this.volume) || identity.fileId !== actual.ino.toString() ||
        identity.created !== (actual.birthtimeNs / 100n + 116444736000000000n).toString()) {
      throw new Error('BOUNDARY_NATIVE_IDENTITY_MISMATCH');
    }
  }

  private request(payload: Record<string, string>): Promise<Response> {
    if (this.closed || this.pending) return Promise.reject(new Error('BOUNDARY_CLOSED_OR_BUSY'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve: response => response.ok ? resolve(response) : reject(new Error(response.error ?? 'BOUNDARY_OPERATION_DENIED')),
        reject, timer: setTimeout(() => this.abort('BOUNDARY_HELPER_TIMEOUT'), 15_000) };
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  private name(name: string): string {
    if (!/^afw-[0-9a-f]{32}$/.test(name)) throw new Error('BOUNDARY_CHILD_NAME_DENIED');
    return path.join(this.managedRoot, name);
  }

  public async reserveChild(name: string): Promise<string> {
    const candidate = this.name(name);
    const result = await this.request({ op: 'reserve', name });
    this.verify(result.identity, candidate);
    this.captured.set(name, result.identity!);
    return candidate;
  }

  public async captureChild(name: string): Promise<string> {
    const candidate = this.name(name);
    const expected = fs.lstatSync(candidate, { bigint: true });
    const result = await this.request({ op: 'capture', name });
    this.verify(result.identity, candidate);
    const current = fs.lstatSync(candidate, { bigint: true });
    if (expected.dev !== current.dev || expected.ino !== current.ino) throw new Error('BOUNDARY_CHILD_IDENTITY_CHANGED');
    this.captured.set(name, result.identity!);
    return candidate;
  }

  public async deleteEmptyChild(name: string): Promise<void> {
    this.name(name);
    await this.request({ op: 'delete-empty', name });
    this.captured.delete(name);
  }

  public capturedIdentity(name: string): NativeIdentity {
    this.name(name);
    const identity = this.captured.get(name);
    if (!identity || this.closed) throw new Error('BOUNDARY_CHILD_NOT_CAPTURED');
    return { ...identity };
  }

  private relative(relative: string): void {
    if (!relative || relative.length > 30_000 || relative.split('/').some(segment =>
      !segment || segment === '.' || segment === '..' || /[\\:\x00-\x1f\x7f*?"<>|]/.test(segment) || /[. ]$/.test(segment))) {
      throw new Error('BOUNDARY_SEGMENT_DENIED');
    }
  }

  public async createDirectory(name: string, relative: string): Promise<void> {
    this.name(name); this.relative(relative);
    await this.request({ op: 'mkdir', name, path: relative });
  }

  public async writeNewFile(name: string, relative: string, contents: Uint8Array): Promise<void> {
    this.name(name); this.relative(relative);
    await this.request({ op: 'file', name, path: relative });
    for (let offset = 0; offset < contents.byteLength; offset += 8192) {
      await this.request({ op: 'append', name, path: relative,
        data: Buffer.from(contents.subarray(offset, offset + 8192)).toString('base64') });
    }
    await this.request({ op: 'finish', name, path: relative, length: String(contents.byteLength) });
  }

  /** Freeze existing ordinary objects before independent owner/clean checks. */
  public async sealTree(name: string): Promise<void> {
    this.name(name);
    await this.request({ op: 'seal', name });
  }

  public async readCapturedFile(name: string, relative: string): Promise<Buffer> {
    this.name(name); this.relative(relative);
    const response = await this.request({ op: 'read', name, path: relative });
    if (typeof response.data !== 'string' || response.data.length > 10_924 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.data)) {
      throw new Error('BOUNDARY_CAPTURED_READ_INVALID');
    }
    return Buffer.from(response.data, 'base64');
  }

  /** Kernel exclusivity fences current helpers; legacy PID metadata is honored. */
  public async acquireOperationLock(owner: { pid: number; token: string; createdAt: number }): Promise<boolean> {
    let response: Response;
    try { response = await this.request({ op: 'operation-acquire' }); } catch { return false; }
    try {
      const previous = Buffer.from(response.data ?? '', 'base64').toString('utf8');
      if (previous) {
        let legacy: { pid?: number; createdAt?: number };
        try { legacy = JSON.parse(previous) as typeof legacy; } catch { throw new Error('BOUNDARY_OPERATION_METADATA_DENIED'); }
        if (!Number.isInteger(legacy.pid) || (legacy.pid ?? 0) <= 0) throw new Error('BOUNDARY_OPERATION_METADATA_DENIED');
        let alive = true;
        try { process.kill(legacy.pid!, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) { await this.request({ op: 'operation-release' }); return false; }
      }
      await this.request({ op: 'operation-claim', data: Buffer.from(JSON.stringify(owner)).toString('base64') });
      return true;
    } catch (error) { await this.request({ op: 'operation-release' }); throw error; }
  }

  /** Requires a sealed tree; never falls back to Git or recursive path removal. */
  public async deleteCapturedTree(name: string): Promise<void> {
    this.name(name);
    await this.request({ op: 'delete-tree', name });
    this.captured.delete(name);
  }

  private abort(code: string): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(code)); this.pending = null; }
    this.closed = true;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  public async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const alreadyClosed = this.closed;
    this.closed = true;
    await new Promise<void>(resolve => {
      // A timeout requests termination; it is never evidence that admitted
      // native mutation has stopped. Release only after the actual exit.
      const timeout = setTimeout(() => { this.child.kill(); }, 5_000);
      this.child.once('exit', () => { clearTimeout(timeout); resolve(); });
      if (alreadyClosed) this.child.kill();
      else this.child.stdin.end(JSON.stringify({ op: 'close' }) + '\n');
    });
  }
}
