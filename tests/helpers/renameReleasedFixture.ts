import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Use only after every owned handle is closed. Windows can briefly retain an
// external scan of a just-created Git fixture; a real leaked pin still fails
// this bounded rename. Held-pin assertions must use renameSync directly.
export function renameReleasedFixture(source: string, destination: string): void {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) ||
      path.dirname(source) !== path.dirname(destination) ||
      !/^(git-revision-boundary-|af-root-lease-)/.test(path.basename(source))) {
    throw new Error('FIXTURE_RENAME_BOUNDARY_CHANGED');
  }
  const deadline = performance.now() + 2_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EBUSY' && code !== 'EPERM') || performance.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
