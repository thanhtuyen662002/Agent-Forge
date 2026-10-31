import fs from 'fs';
import path from 'path';

export interface ReviewContextLimits {
  maxFiles: number;
  maxTraversalEntries: number;
}

/** Never part of a provider workspace; not worth counting. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * #374: the reviewer reads the coder's authorized context inside the verified
 * worktree, which now also holds every file the coder created. A context that
 * fit the provider workspace at coding time can overflow it at review time and
 * fail every review. When it no longer fits, the reviewer gets the files the
 * context names explicitly plus the files the coder changed, without whole
 * directories. It never adds a path outside the context or the changed files.
 */
export function reviewContextFiles(worktree: string, contextFiles: string[], changedFiles: string[], limits: ReviewContextLimits): string[] {
  if (fitsWorkspace(worktree, contextFiles, limits)) return contextFiles;
  const chosen: string[] = [];
  const seen = new Set<string>();
  const take = (relative: string) => {
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (seen.has(key) || chosen.length >= limits.maxFiles || !isFile(worktree, relative)) return;
    seen.add(key);
    chosen.push(relative);
  };
  contextFiles.forEach(take);
  changedFiles.forEach(take);
  return chosen.length > 0 ? chosen : contextFiles;
}

function fitsWorkspace(worktree: string, contextFiles: string[], limits: ReviewContextLimits): boolean {
  const files = new Set<string>();
  let entries = 0;
  const visit = (absolute: string): boolean => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(absolute); } catch { return true; }
    if (stat.isSymbolicLink()) return true;
    if (stat.isFile()) {
      files.add(process.platform === 'win32' ? absolute.toLowerCase() : absolute);
      return files.size <= limits.maxFiles;
    }
    if (!stat.isDirectory()) return true;
    let children: string[];
    try { children = fs.readdirSync(absolute); } catch { return true; }
    entries += children.length;
    if (entries > limits.maxTraversalEntries) return false;
    return children.every((child) => SKIPPED_DIRECTORIES.has(child) || visit(path.join(absolute, child)));
  };
  return contextFiles.every((relative) => visit(path.resolve(worktree, relative)));
}

function isFile(worktree: string, relative: string): boolean {
  try {
    return fs.lstatSync(path.resolve(worktree, relative)).isFile();
  } catch {
    return false;
  }
}
