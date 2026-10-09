import { it } from 'vitest';

// Captured worktree mutation currently uses Windows native handles. Preserve
// the complete integration assertions as mandatory Windows tests even if the
// native helper fails to start. Portable authority tests use ordinary `it`.
export const testWindowsWorktree = it.runIf(process.platform === 'win32');

// Windows also exercises the actual unsupported branch deterministically.
// Ubuntu reaches it with its real platform; no service/adapter is substituted.
export async function withoutWindowsWorktreeBoundary<T>(run: () => Promise<T>): Promise<T> {
  if (process.platform !== 'win32') return run();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  try { return await run(); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
}
