import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WINDOWS_DIRECTORY_BOUNDARY } from './worktreeBoundaryScripts';

interface NativeIdentity { volume: string; fileId: string }
interface Response { ok: boolean; identity?: NativeIdentity; error?: string }

/** Windows kernel primitives, awaiting complete Git/ownership integration. */
export class WorktreeMutationBoundary {
  private buffer = '';
  private closed = false;
  private volume: string | null = null;
  private pending: { resolve: (value: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

  private constructor(private readonly child: ChildProcessWithoutNullStreams, public readonly managedRoot: string) {
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

  public static async acquire(managedRoot: string): Promise<WorktreeMutationBoundary> {
    if (process.platform !== 'win32') throw new Error('UNSUPPORTED_MUTATION_BOUNDARY');
    const root = fs.realpathSync.native(managedRoot);
    if (root.toLowerCase() !== path.resolve(managedRoot).toLowerCase() || fs.lstatSync(managedRoot).isSymbolicLink()) {
      throw new Error('BOUNDARY_ROOT_ALIAS_DENIED');
    }
    const expected = fs.lstatSync(root, { bigint: true });
    if (!expected.isDirectory() || expected.isSymbolicLink()) throw new Error('BOUNDARY_ROOT_DENIED');
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_DIRECTORY_BOUNDARY, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
    const boundary = new WorktreeMutationBoundary(child, root);
    try {
      const response = await boundary.request({ root });
      boundary.verify(response.identity, root);
      boundary.volume = response.identity!.volume;
      const actual = fs.lstatSync(root, { bigint: true });
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
        !/^\d+$/.test(identity.volume) || identity.volume === '0' ||
        (this.volume !== null && identity.volume !== this.volume) || identity.fileId !== actual.ino.toString()) {
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
    return candidate;
  }

  public async captureChild(name: string): Promise<string> {
    const candidate = this.name(name);
    const expected = fs.lstatSync(candidate, { bigint: true });
    const result = await this.request({ op: 'capture', name });
    this.verify(result.identity, candidate);
    const current = fs.lstatSync(candidate, { bigint: true });
    if (expected.dev !== current.dev || expected.ino !== current.ino) throw new Error('BOUNDARY_CHILD_IDENTITY_CHANGED');
    return candidate;
  }

  public async deleteEmptyChild(name: string): Promise<void> {
    this.name(name);
    await this.request({ op: 'delete-empty', name });
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
      const timeout = setTimeout(() => { this.child.kill(); resolve(); }, 5_000);
      this.child.once('exit', () => { clearTimeout(timeout); resolve(); });
      if (alreadyClosed) this.child.kill();
      else this.child.stdin.end(JSON.stringify({ op: 'close' }) + '\n');
    });
  }
}
