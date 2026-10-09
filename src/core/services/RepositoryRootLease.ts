import fs from 'node:fs';
import path from 'node:path';
import { assertRepositoryRootIdentity, RepositoryRootError, RepositoryRootIdentity } from './RepositoryRootIdentity';
import { WindowsRepositoryRootLease } from './WindowsRepositoryRootLease';

/** Holds the selected objects, never a replaced path, through one operation. */
export class RepositoryRootLease {
  private windows?: WindowsRepositoryRootLease;
  private descriptors: number[] = [];
  private closed = false;
  public readonly cwd: string;

  private constructor(public readonly identity: RepositoryRootIdentity, cwd: string) { this.cwd = cwd; }

  public static acquire(identity: RepositoryRootIdentity): RepositoryRootLease {
    assertRepositoryRootIdentity(identity);
    let lease = new RepositoryRootLease(identity, identity.canonicalPath);
    try {
      if (process.platform === 'win32') {
        lease.windows = WindowsRepositoryRootLease.acquire(identity);
      } else if (process.platform === 'linux' && fs.constants.O_DIRECTORY && fs.constants.O_NOFOLLOW) {
        const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
        for (const [index, expected] of identity.components.entries()) {
          const candidate = index === 0 ? expected.path :
            `/proc/self/fd/${lease.descriptors[index - 1]}/${path.basename(expected.path)}`;
          const descriptor = fs.openSync(candidate, flags);
          lease.descriptors.push(descriptor);
          const actual = fs.fstatSync(descriptor, { bigint: true });
          if (!actual.isDirectory() || actual.dev.toString() !== expected.device || actual.ino.toString() !== expected.inode ||
              actual.birthtimeNs.toString() !== expected.createdNs) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
        }
        const descriptors = lease.descriptors;
        lease = new RepositoryRootLease(identity, `/proc/${process.pid}/fd/${descriptors[descriptors.length - 1]}`);
        lease.descriptors = descriptors;
      } else throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
      lease.assertActive();
      return lease;
    } catch (error) {
      lease.close();
      if (error instanceof RepositoryRootError) throw error;
      throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
    }
  }

  public assertActive(): void {
    if (this.closed) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
    this.windows?.assertActive();
    this.descriptors.forEach((descriptor, i) => {
      const actual = fs.fstatSync(descriptor, { bigint: true });
      const expected = this.identity.components[i];
      if (!actual.isDirectory() || actual.dev.toString() !== expected.device || actual.ino.toString() !== expected.inode ||
          actual.birthtimeNs.toString() !== expected.createdNs) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
    });
    assertRepositoryRootIdentity(this.identity);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.windows?.close();
    for (const descriptor of this.descriptors.reverse()) fs.closeSync(descriptor);
    this.descriptors = [];
  }
}
