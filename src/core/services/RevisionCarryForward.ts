import fs from 'fs';
import path from 'path';
import type { CarriedFile } from '../adapters/ProviderAdapter';
import type { Repository } from '../database/repositories';
import type { ExecutionAuthorization } from '../types/domain';
import { VERIFICATION_FAILED_EVENT, VERIFICATION_PASSED_EVENT } from './AutomatedVerificationService';

/** Bounds on what one coder run carries forward from its task's previous revision (#352). */
export const MAX_CARRIED_FILES = 64;
export const MAX_CARRIED_BYTES = 8 * 1024 * 1024;

interface VerifiedRun {
  authorizationId?: unknown;
  worktree?: unknown;
  headSha?: unknown;
  changedFiles?: unknown;
}

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Every coder run starts in a fresh managed worktree at the repository HEAD, so a fix
 * revision could not see the code its own task wrote before (VidFlow M6.1: revision 1
 * was told to fix src/render/plans.ts and reported its workspace lacked it). The files
 * the latest earlier verified run of this task changed are read from that run's retained
 * worktree, which must lie inside the project's managed root. When HEAD has moved since,
 * only files absent at the new HEAD are carried, so another task's change to a shared file
 * is never reverted. Deleted files are not carried. The adapter re-checks scope and policy.
 */
export function collectCarriedFiles(
  repo: Repository,
  auth: ExecutionAuthorization,
  workingDirectory: string,
  managedRoot: string,
): CarriedFile[] {
  const runs = repo.getProjectEventsOfTypes(auth.project_id, [VERIFICATION_PASSED_EVENT, VERIFICATION_FAILED_EVENT], auth.task_id)
    .map((event) => (event.structured_payload ?? {}) as VerifiedRun)
    .filter((run) => run.authorizationId !== auth.id && typeof run.worktree === 'string' &&
      Array.isArray(run.changedFiles) && run.changedFiles.length > 0);
  const previous = runs[0];
  if (!previous) return [];

  let root: string;
  let previousWorktree: string;
  try {
    root = fs.realpathSync.native(managedRoot);
    const stat = fs.lstatSync(previous.worktree as string);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    previousWorktree = fs.realpathSync.native(previous.worktree as string);
  } catch {
    return [];
  }
  if (!inside(previousWorktree, root) || path.resolve(previousWorktree) === path.resolve(workingDirectory)) return [];

  const headMoved = typeof previous.headSha !== 'string' ||
    previous.headSha.toLowerCase() !== String(auth.repository_head_sha ?? '').toLowerCase();
  const carried: CarriedFile[] = [];
  let bytes = 0;
  for (const changed of previous.changedFiles as unknown[]) {
    if (carried.length >= MAX_CARRIED_FILES) break;
    if (typeof changed !== 'string') continue;
    const relative = changed.replace(/\\/g, '/');
    if (relative.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git')) continue;
    const source = path.resolve(previousWorktree, relative);
    if (!inside(source, previousWorktree)) continue;
    if (headMoved && fs.existsSync(path.resolve(workingDirectory, relative))) continue;
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || bytes + stat.size > MAX_CARRIED_BYTES) continue;
      if (!inside(fs.realpathSync.native(source), previousWorktree)) continue;
      const content = fs.readFileSync(source);
      bytes += content.byteLength;
      carried.push({ relativePath: relative, content });
    } catch {
      // A file the previous revision deleted, or one that vanished since, is not carried.
    }
  }
  return carried;
}
