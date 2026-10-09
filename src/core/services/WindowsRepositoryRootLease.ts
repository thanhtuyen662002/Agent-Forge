import fs from 'node:fs';
import path from 'node:path';
import * as koffi from 'koffi';
import { assertRepositoryRootIdentity, RepositoryRootError, RepositoryRootIdentity } from './RepositoryRootIdentity';

interface FileTime { low: number; high: number }
interface FileInformation {
  attributes: number; created: FileTime; accessed: FileTime; written: FileTime;
  volume: number; sizeHigh: number; sizeLow: number; links: number; indexHigh: number; indexLow: number;
}

function unavailable(): never { throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE'); }
function changed(): never { throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED'); }

// No callbacks or unmanaged-memory views. The repository process owns every
// handle, so loss of a separate helper cannot release a live invocation's pins.
function loadNative() {
  const kernel = koffi.load('kernel32.dll');
  const nt = koffi.load('ntdll.dll');
  const time = koffi.struct({ low: 'uint32', high: 'uint32' });
  const information = koffi.struct({ attributes: 'uint32', created: time, accessed: time, written: time,
    volume: 'uint32', sizeHigh: 'uint32', sizeLow: 'uint32', links: 'uint32', indexHigh: 'uint32', indexLow: 'uint32' });
  const unicode = koffi.struct({ length: 'uint16', maximumLength: 'uint16', buffer: 'str16' });
  const attributes = koffi.struct({ length: 'uint32', root: 'void *', name: koffi.pointer(unicode),
    attributes: 'uint32', securityDescriptor: 'void *', securityQuality: 'void *' });
  const io = koffi.struct({ status: 'intptr', information: 'uintptr' });
  return {
    create: kernel.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
    info: kernel.func('__stdcall', 'GetFileInformationByHandle', 'int', ['void *', koffi.out(koffi.pointer(information))]),
    finalPath: kernel.func('__stdcall', 'GetFinalPathNameByHandleW', 'uint32', ['void *', koffi.out(koffi.pointer('uint16')), 'uint32', 'uint32']),
    relative: nt.func('__stdcall', 'NtCreateFile', 'int32', [koffi.out(koffi.pointer('void *')), 'uint32',
      koffi.pointer(attributes), koffi.out(koffi.pointer(io)), 'void *', 'uint32', 'uint32', 'uint32', 'uint32', 'void *', 'uint32']),
    close: kernel.func('__stdcall', 'CloseHandle', 'int', ['void *']),
    attributesSize: koffi.sizeof(attributes),
  };
}

let native: ReturnType<typeof loadNative> | undefined;
function api(): ReturnType<typeof loadNative> {
  if (process.platform !== 'win32') unavailable();
  try { return native ??= loadNative(); } catch { unavailable(); }
}

/** Read-only name lease: captured ordinary ancestry plus a pinned root child. */
export class WindowsRepositoryRootLease {
  private readonly handles: bigint[] = [];
  private closed = false;
  private volume: number | undefined;

  private constructor(private readonly identity: RepositoryRootIdentity) {}

  private information(handle: bigint, directory: boolean): FileInformation {
    const info = {} as FileInformation;
    if (!api().info(handle, info) || (info.attributes & 0x400) !== 0 ||
        ((info.attributes & 0x10) !== 0) !== directory || info.volume === 0 ||
        (info.indexHigh === 0 && info.indexLow === 0)) changed();
    if (this.volume !== undefined && info.volume !== this.volume) changed();
    this.volume ??= info.volume;
    return info;
  }

  private ordinaryRelative(parent: bigint, name: string, directory: boolean): bigint {
    if (!name || name.length > 255 || name === '.' || name === '..' || /[\\/:\x00-\x1f\x7f*?"<>|]/.test(name) || /[. ]$/.test(name)) unavailable();
    const output: (bigint | null)[] = [null];
    const objectAttributes = { length: api().attributesSize, root: parent,
      name: { length: name.length * 2, maximumLength: (name.length + 1) * 2, buffer: name },
      attributes: 0x40, securityDescriptor: null, securityQuality: null };
    const status = api().relative(output, 0x100081, objectAttributes, {}, null, 0, 1, 1,
      0x200020 | (directory ? 1 : 0x40), null, 0);
    const handle = output[0];
    if (status < 0 || handle === null || handle === 0n || handle === -1n) {
      if (handle !== null && handle !== 0n && handle !== -1n) api().close(handle);
      changed();
    }
    this.handles.push(handle);
    this.information(handle, directory);
    return handle;
  }

  private matchComponent(handle: bigint, expected: RepositoryRootIdentity['components'][number]): void {
    const info = this.information(handle, true);
    const fileId = ((BigInt(info.indexHigh) << 32n) | BigInt(info.indexLow)).toString();
    const created = ((BigInt(info.created.high) << 32n) | BigInt(info.created.low));
    if (fileId !== expected.inode || created !== BigInt(expected.createdNs) / 100n + 116444736000000000n) changed();
    const text = new Uint16Array(32_768);
    const length = api().finalPath(handle, text, text.length, 0);
    if (length === 0 || length >= text.length) unavailable();
    const final = Buffer.from(text.buffer, 0, length * 2).toString('utf16le').replace(/^\\\\\?\\/, '');
    if (final.replace(/\\$/, '').toLowerCase() !== expected.path.replace(/\\$/, '').toLowerCase()) changed();
  }

  public static acquire(identity: RepositoryRootIdentity): WindowsRepositoryRootLease {
    assertRepositoryRootIdentity(identity);
    const lease = new WindowsRepositoryRootLease(identity);
    try {
      const first = identity.components[0];
      const root = api().create(first.path, 0x81, 1, null, 3, 0x02200000, null) as bigint | null;
      if (root === null || root === 0n || root === -1n || root === 0xffffffffffffffffn) unavailable();
      lease.handles.push(root);
      lease.matchComponent(root, first);
      let parent = root;
      for (const component of identity.components.slice(1)) {
        parent = lease.ordinaryRelative(parent, path.basename(component.path), true);
        lease.matchComponent(parent, component);
      }
      // Every ancestor contains its already-pinned next component. The final
      // root also needs a pinned ordinary child: an empty directory can be
      // converted to a junction by an attributes-only writer despite sharing.
      // A genuine working tree has .git as a directory or an ordinary pointer
      // file. No marker is created and no filesystem object is modified.
      const git = fs.lstatSync(path.join(identity.canonicalPath, '.git'), { bigint: true });
      if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile()) || git.ino === 0n) unavailable();
      const child = lease.ordinaryRelative(parent, '.git', git.isDirectory());
      const info = lease.information(child, git.isDirectory());
      if (((BigInt(info.indexHigh) << 32n) | BigInt(info.indexLow)).toString() !== git.ino.toString() ||
          ((BigInt(info.created.high) << 32n) | BigInt(info.created.low)) !== git.birthtimeNs / 100n + 116444736000000000n) changed();
      lease.assertActive();
      return lease;
    } catch (error) {
      lease.close();
      if (error instanceof RepositoryRootError) throw error;
      unavailable();
    }
  }

  public assertActive(): void {
    if (this.closed) unavailable();
    this.identity.components.forEach((component, i) => this.matchComponent(this.handles[i], component));
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.handles.reverse()) api().close(handle);
    this.handles.length = 0;
  }
}
